import { describe, expect, it, vi } from "vitest";
import {
  fetchNxtCodexQuotaStatus,
  maskApiKey,
  parseHeaderValue,
  parseResetTimestamp
} from "@ltm/provider-quota";

const now = new Date("2026-07-25T12:00:00.000Z");

describe("nxtcodex key masking", () => {
  it("masks API keys preserving prefix and last 4 chars", () => {
    expect(maskApiKey("nxt_1234567890abcdef7f2a")).toBe("nxt_****7f2a");
    expect(maskApiKey("sk-proj-1234567890abcd")).toBe("sk-p****abcd");
    expect(maskApiKey("short")).toBe("nxt_****");
    expect(maskApiKey("")).toBeUndefined();
    expect(maskApiKey(undefined)).toBeUndefined();
  });
});

describe("nxtcodex header & reset parsing", () => {
  it("parses header numeric values", () => {
    expect(parseHeaderValue("1000")).toBe(1000);
    expect(parseHeaderValue(" 50 ")).toBe(50);
    expect(parseHeaderValue("-10")).toBeNull();
    expect(parseHeaderValue("abc")).toBeNull();
    expect(parseHeaderValue(undefined)).toBeNull();
  });

  it("parses reset timestamps in various formats", () => {
    // Relative seconds (3600s = 1 hour ahead)
    const rel = parseResetTimestamp("3600", now);
    expect(rel.secondsUntilReset).toBe(3600);
    expect(rel.resetAt).toBe("2026-07-25T13:00:00.000Z");

    // Unix timestamp in seconds
    const unixSec = parseResetTimestamp("1784990400", now);
    expect(unixSec.resetAt).toBe("2026-07-25T14:40:00.000Z");

    // ISO string
    const iso = parseResetTimestamp("2026-07-25T15:00:00Z", now);
    expect(iso.secondsUntilReset).toBe(10800);
    expect(iso.resetAt).toBe("2026-07-25T15:00:00.000Z");
  });
});

describe("nxtcodex fetchNxtCodexQuotaStatus adapter", () => {
  it("returns unknown status when network requests are disabled", async () => {
    const status = await fetchNxtCodexQuotaStatus({
      allowNetwork: false,
      now,
      customEnv: { NXTCODEX_API_KEY: "nxt_test1234567890key7f2a" }
    });
    expect(status.provider).toBe("nxtcodex");
    expect(status.keyId).toBe("nxt_****7f2a");
    expect(status.status).toBe("unknown");
    expect(status.error).toContain("Network requests disabled");
  });

  it("parses JSON response body from official quota endpoint", async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({
        total: 10000,
        used: 2500,
        remaining: 7500,
        unit: "tokens",
        resetAt: "2026-07-25T18:00:00Z",
        status: "active"
      })
    });

    const status = await fetchNxtCodexQuotaStatus({
      allowNetwork: true,
      now,
      fetcher: mockFetcher as any,
      customEnv: {
        NXTCODEX_API_KEY: "nxt_1234567890abcdef7f2a",
        NXTCODEX_QUOTA_ENDPOINT: "https://nxtcodex.com/v1/user/quota"
      }
    });

    expect(status.provider).toBe("nxtcodex");
    expect(status.keyId).toBe("nxt_****7f2a");
    expect(status.status).toBe("active");
    expect(status.total).toBe(10000);
    expect(status.used).toBe(2500);
    expect(status.remaining).toBe(7500);
    expect(status.unit).toBe("tokens");
    expect(status.source).toBe("official_api");
    expect(status.resetAt).toBe("2026-07-25T18:00:00.000Z");
    expect(status.secondsUntilReset).toBe(21600);
  });

  it("parses rate limit response headers when body has no explicit quota", async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        "x-ratelimit-limit": "500",
        "x-ratelimit-remaining": "120",
        "x-ratelimit-reset": "1800"
      }),
      text: async () => JSON.stringify({ data: [] })
    });

    const status = await fetchNxtCodexQuotaStatus({
      allowNetwork: true,
      now,
      fetcher: mockFetcher as any,
      customEnv: { NXTCODEX_API_KEY: "nxt_1234567890abcdef7f2a" }
    });

    expect(status.status).toBe("active");
    expect(status.total).toBe(500);
    expect(status.remaining).toBe(120);
    expect(status.used).toBe(380);
    expect(status.secondsUntilReset).toBe(1800);
    expect(status.source).toBe("response_headers");
  });

  it("handles 401 Unauthorized status cleanly", async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: "Invalid key" })
    });

    const status = await fetchNxtCodexQuotaStatus({
      allowNetwork: true,
      now,
      fetcher: mockFetcher as any,
      customEnv: { NXTCODEX_API_KEY: "nxt_badkey1234567897f2a" }
    });

    expect(status.status).toBe("invalid");
    expect(status.error).toContain("401");
  });

  it("handles 429 Rate Limit Exceeded status", async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ "x-ratelimit-reset": "60" }),
      text: async () => JSON.stringify({ error: "Rate limit exceeded" })
    });

    const status = await fetchNxtCodexQuotaStatus({
      allowNetwork: true,
      now,
      fetcher: mockFetcher as any,
      customEnv: { NXTCODEX_API_KEY: "nxt_1234567890abcdef7f2a" }
    });

    expect(status.status).toBe("limited");
    expect(status.remaining).toBe(0);
    expect(status.secondsUntilReset).toBe(60);
  });
});
