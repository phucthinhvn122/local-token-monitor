import { describe, expect, it, vi } from "vitest";
import {
  CompatibleQuotaAdapter,
  parseExplicitQuotaBody,
  parseQuotaHeaders,
  parseResetAt,
  parseUsageBody
} from "@ltm/provider-quota";
import type { ThirdPartyProviderConfig } from "@ltm/shared-types";

const now = new Date("2026-07-25T00:00:00.000Z");

const config = (patch: Partial<ThirdPartyProviderConfig> = {}): ThirdPartyProviderConfig => ({
  id: "openai-compatible",
  adapterId: "openai-compatible",
  displayName: "Test provider",
  quotaEndpoint: "https://quota.example.test/v1/limits",
  apiKeyEnv: "TEST_PROVIDER_KEY",
  protocol: "openai",
  enabled: true,
  refreshIntervalMinutes: 15,
  endpointVerified: false,
  ...patch
});

describe("quota reset parsing", () => {
  it("supports relative, Unix seconds, milliseconds, and RFC 3339 formats", () => {
    expect(parseResetAt("1m30s", now)).toBe("2026-07-25T00:01:30.000Z");
    expect(parseResetAt("250ms", now)).toBe("2026-07-25T00:00:00.250Z");
    expect(parseResetAt("1784937600", now)).toBe("2026-07-25T00:00:00.000Z");
    expect(parseResetAt("1784937600000", now)).toBe("2026-07-25T00:00:00.000Z");
    expect(parseResetAt("2026-07-25T01:00:00Z", now)).toBe("2026-07-25T01:00:00.000Z");
  });
});

describe("rate-limit header parsing", () => {
  it("parses OpenAI-compatible request and token headers", () => {
    const snapshot = parseQuotaHeaders("openai-compatible", "openai", {
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "73",
      "x-ratelimit-reset-requests": "30s",
      "x-ratelimit-limit-tokens": "50000",
      "x-ratelimit-remaining-tokens": "12500",
      "x-ratelimit-reset-tokens": "1m"
    }, now);
    expect(snapshot.status).toBe("available");
    expect(snapshot.metrics.find((metric) => metric.kind === "requests")).toMatchObject({
      limit: 100,
      remaining: 73,
      used: 27
    });
    expect(snapshot.metrics.find((metric) => metric.kind === "tokens")?.resetsAt).toBe("2026-07-25T00:01:00.000Z");
  });

  it("parses Anthropic request, combined, input, and output token headers", () => {
    const snapshot = parseQuotaHeaders("anthropic-compatible", "anthropic", {
      "anthropic-ratelimit-requests-limit": "60",
      "anthropic-ratelimit-requests-remaining": "59",
      "anthropic-ratelimit-requests-reset": "2026-07-25T00:00:01Z",
      "anthropic-ratelimit-tokens-limit": "40000",
      "anthropic-ratelimit-tokens-remaining": "39000",
      "anthropic-ratelimit-input-tokens-limit": "30000",
      "anthropic-ratelimit-input-tokens-remaining": "29000",
      "anthropic-ratelimit-output-tokens-limit": "10000",
      "anthropic-ratelimit-output-tokens-remaining": "10000"
    }, now);
    expect(snapshot.metrics.map((metric) => metric.kind)).toEqual([
      "requests", "tokens", "input-tokens", "output-tokens"
    ]);
  });

  it("ignores missing and negative values without crashing", () => {
    const snapshot = parseQuotaHeaders("openai-compatible", "openai", {
      "x-ratelimit-limit-tokens": "-5",
      "x-ratelimit-remaining-tokens": "not-a-number"
    }, now);
    expect(snapshot.metrics).toEqual([]);
    expect(snapshot.status).toBe("unavailable");
  });
});

describe("usage body parsing", () => {
  it("uses an OpenAI provider total without adding cached or reasoning tokens twice", () => {
    const snapshot = parseUsageBody("openai-compatible", "openai", {
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
        input_tokens_details: { cached_tokens: 70 },
        output_tokens_details: { reasoning_tokens: 25 }
      }
    }, now);
    expect(snapshot.metrics[0].used).toBe(140);
    expect(snapshot.status).toBe("partial");
  });

  it("parses the final OpenAI SSE usage frame", () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hello"}}]}',
      'data: {"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}',
      "data: [DONE]"
    ].join("\n\n");
    expect(parseUsageBody("openai-compatible", "openai", sse, now).metrics[0].used).toBe(17);
  });

  it("merges Anthropic streaming input, output, and cache usage once", () => {
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":1,"cache_read_input_tokens":100,"cache_creation_input_tokens":10}}}',
      'data: {"type":"message_delta","usage":{"output_tokens":8}}'
    ].join("\n\n");
    expect(parseUsageBody("anthropic-compatible", "anthropic", sse, now).metrics[0].used).toBe(138);
  });

  it("survives HTML, malformed JSON, and unknown schema changes", () => {
    expect(parseUsageBody("openai-compatible", "openai", "<html>login</html>", now).status).toBe("unavailable");
    expect(parseUsageBody("openai-compatible", "openai", '{"future":true}', now).metrics).toEqual([]);
    expect(parseUsageBody("openai-compatible", "openai", "data: {partial", now).metrics).toEqual([]);
  });

  it("parses only explicit configured quota and credit structures", () => {
    const snapshot = parseExplicitQuotaBody("openai-compatible", "openai", {
      data: {
        quotas: [
          { name: "requests", limit: 100, remaining: 60, reset_seconds: 30 },
          { name: "tokens", limit: 10000, remaining: 7500 }
        ],
        credits: { remaining: 12.5, total: 20, unit: "credits" }
      }
    }, now);
    expect(snapshot.status).toBe("available");
    expect(snapshot.confidence).toBe("medium");
    expect(snapshot.metrics.find((metric) => metric.kind === "requests")?.used).toBe(40);
    expect(snapshot.metrics.find((metric) => metric.kind === "credits")?.remaining).toBe(12.5);
  });

  it("does not infer quota from ambiguous fields", () => {
    const snapshot = parseExplicitQuotaBody("openai-compatible", "openai", {
      data: { remaining: 999, total: 1000 }
    }, now);
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.metrics).toEqual([]);
  });
});

describe("direct quota fetch safety", () => {
  it.each([401, 403])("stops on HTTP %s without retrying", async (status) => {
    process.env.TEST_PROVIDER_KEY = "secret-value";
    const fetcher = vi.fn(async () => new Response("{}", {
      status,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
    const snapshot = await new CompatibleQuotaAdapter(config()).fetchQuota({
      allowNetwork: true,
      now,
      fetcher
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(snapshot.status).toBe("error");
    expect(snapshot.error).not.toContain("secret-value");
    delete process.env.TEST_PROVIDER_KEY;
  });

  it("honors 429 Retry-After metadata without retrying", async () => {
    process.env.TEST_PROVIDER_KEY = "secret-value";
    const fetcher = vi.fn(async () => new Response("{}", {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "45",
        "x-ratelimit-limit-requests": "10",
        "x-ratelimit-remaining-requests": "0"
      }
    })) as unknown as typeof fetch;
    const snapshot = await new CompatibleQuotaAdapter(config()).fetchQuota({
      allowNetwork: true,
      now,
      fetcher
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(snapshot.retryAfterAt).toBe("2026-07-25T00:00:45.000Z");
    expect(snapshot.httpStatus).toBe(429);
    delete process.env.TEST_PROVIDER_KEY;
  });

  it("discards HTML responses and never returns a credential", async () => {
    process.env.TEST_PROVIDER_KEY = "do-not-leak";
    const fetcher = vi.fn(async () => new Response("<html>sign in</html>", {
      status: 200,
      headers: { "content-type": "text/html" }
    })) as unknown as typeof fetch;
    const snapshot = await new CompatibleQuotaAdapter(config()).fetchQuota({
      allowNetwork: true,
      now,
      fetcher
    });
    expect(JSON.stringify(snapshot)).not.toContain("do-not-leak");
    expect(snapshot.error).toContain("non-JSON");
    delete process.env.TEST_PROVIDER_KEY;
  });

  it("does not make a request when network access is disabled", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const snapshot = await new CompatibleQuotaAdapter(config()).fetchQuota({
      allowNetwork: false,
      now,
      fetcher
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(snapshot.error).toContain("disabled");
  });

  it("does not serialize a credential embedded in an invalid endpoint URL", async () => {
    const snapshot = await new CompatibleQuotaAdapter(config({
      quotaEndpoint: "https://quota.example.test/v1/limits?api_key=never-store-this"
    })).fetchQuota({
      allowNetwork: true,
      now,
      fetcher: vi.fn() as unknown as typeof fetch
    });
    expect(JSON.stringify(snapshot)).not.toContain("never-store-this");
    expect(snapshot.status).toBe("error");
  });

  it("rejects private endpoints before calling fetch", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const snapshot = await new CompatibleQuotaAdapter(config({
      quotaEndpoint: "https://127.0.0.1/v1/quota",
      apiKeyEnv: undefined
    })).fetchQuota({ allowNetwork: true, now, fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    expect(snapshot.error).toContain("private");
  });

  it("rejects oversized quota bodies", async () => {
    process.env.TEST_PROVIDER_KEY = "secret-value";
    const fetcher = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "1000001"
      }
    })) as unknown as typeof fetch;
    const snapshot = await new CompatibleQuotaAdapter(config()).fetchQuota({
      allowNetwork: true,
      now,
      fetcher
    });
    expect(snapshot.status).toBe("error");
    expect(snapshot.error).toContain("1 MB");
    delete process.env.TEST_PROVIDER_KEY;
  });
});
