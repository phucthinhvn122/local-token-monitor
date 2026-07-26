import { describe, expect, it } from "vitest";
import {
  inspectSseEvent,
  normalizeUsage,
  parseSseEvents,
  usageFromBody,
  withUsageReporting
} from "../apps/gateway/src/lib/usage.js";
import { calculateCost, estimateRequestTokens } from "../packages/token-estimator/src/index.js";

describe("usage normalisation", () => {
  it("reads Chat Completions field names", () => {
    expect(
      normalizeUsage({
        prompt_tokens: 100,
        completion_tokens: 40,
        total_tokens: 140,
        prompt_tokens_details: { cached_tokens: 25 }
      })
    ).toEqual({ inputTokens: 100, outputTokens: 40, cachedTokens: 25, totalTokens: 140 });
  });

  it("reads Responses API field names", () => {
    expect(
      normalizeUsage({
        input_tokens: 80,
        output_tokens: 20,
        total_tokens: 100,
        input_tokens_details: { cached_tokens: 10 }
      })
    ).toEqual({ inputTokens: 80, outputTokens: 20, cachedTokens: 10, totalTokens: 100 });
  });

  it("prefers the provider total over the component sum", () => {
    // Some providers bill components the response does not itemise.
    const usage = normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 99 });
    expect(usage?.totalTokens).toBe(99);
  });

  it("derives the total when the provider omits it", () => {
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5 })?.totalTokens).toBe(15);
  });

  it("returns null for an absent or empty usage object", () => {
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage({})).toBeNull();
    expect(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 })).toBeNull();
  });

  it("rounds fractional counts and ignores negatives", () => {
    expect(normalizeUsage({ prompt_tokens: 10.4, completion_tokens: -5 })).toEqual({
      inputTokens: 10,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 10
    });
  });

  it("finds usage nested under `response`", () => {
    expect(usageFromBody({ response: { usage: { input_tokens: 7, output_tokens: 3 } } })?.totalTokens).toBe(10);
  });
});

describe("SSE framing", () => {
  it("only emits complete events and keeps the remainder", () => {
    const { events, rest } = parseSseEvents('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"par');
    expect(events).toHaveLength(2);
    expect(rest).toBe('data: {"par');
  });

  it("handles CRLF separators", () => {
    const { events } = parseSseEvents('data: {"a":1}\r\n\r\n');
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"a":1}');
  });

  it("captures the event name and joins multi-line data", () => {
    const { events } = parseSseEvents("event: response.completed\ndata: {\ndata: }\n\n");
    expect(events[0].event).toBe("response.completed");
    expect(events[0].data).toBe("{\n}");
  });

  it("preserves the raw bytes so they can be forwarded verbatim", () => {
    const raw = 'data: {"a":1}\n\n';
    expect(parseSseEvents(raw).events[0].raw).toBe(raw);
  });
});

describe("streaming usage capture", () => {
  it("recognises the usage-only chunk that include_usage adds", () => {
    const [event] = parseSseEvents(
      'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":12,"total_tokens":42}}\n\n'
    ).events;
    const result = inspectSseEvent(event);
    expect(result.usageOnly).toBe(true);
    expect(result.usage?.totalTokens).toBe(42);
  });

  it("does not flag a content chunk as usage-only", () => {
    const [event] = parseSseEvents('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n').events;
    const result = inspectSseEvent(event);
    expect(result.usageOnly).toBe(false);
    expect(result.outputText).toBe("hi");
  });

  it("reads usage from the Responses API completion event", () => {
    const [event] = parseSseEvents(
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":50,"output_tokens":25,"total_tokens":75}}}\n\n'
    ).events;
    expect(inspectSseEvent(event).usage?.totalTokens).toBe(75);
  });

  it("ignores [DONE] and malformed payloads", () => {
    const { events } = parseSseEvents("data: [DONE]\n\ndata: not json\n\n");
    for (const event of events) expect(inspectSseEvent(event).usage).toBeNull();
  });

  it("accumulates tool-call arguments as output text for the fallback", () => {
    const [event] = parseSseEvents(
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"x\\":1}"}}]}}]}\n\n'
    ).events;
    expect(inspectSseEvent(event).outputText).toBe('{"x":1}');
  });
});

describe("include_usage injection", () => {
  it("adds stream_options when the client omitted it", () => {
    const result = withUsageReporting({ model: "gpt-5-codex", stream: true });
    expect(result.body.stream_options).toEqual({ include_usage: true });
    // The client did not ask, so the extra chunk must be filtered out again.
    expect(result.clientRequestedUsage).toBe(false);
  });

  it("passes the chunk through when the client asked for it", () => {
    const result = withUsageReporting({ stream: true, stream_options: { include_usage: true } });
    expect(result.clientRequestedUsage).toBe(true);
  });

  it("preserves other stream_options", () => {
    const result = withUsageReporting({ stream: true, stream_options: { other: 1 } });
    expect(result.body.stream_options).toEqual({ other: 1, include_usage: true });
  });

  it("does not mutate the caller's body", () => {
    const original = { stream: true };
    withUsageReporting(original);
    expect(original).toEqual({ stream: true });
  });
});

describe("estimation fallback", () => {
  it("collects text from chat messages and responses input alike", () => {
    const chat = estimateRequestTokens({ messages: [{ role: "user", content: "hello world" }] });
    const responses = estimateRequestTokens({ input: [{ content: [{ text: "hello world" }] }] });
    expect(chat.tokens).toBeGreaterThan(0);
    expect(responses.tokens).toBe(chat.tokens);
  });

  it("returns zero tokens for an empty request", () => {
    expect(estimateRequestTokens({}).tokens).toBe(0);
  });
});

describe("cost calculation", () => {
  const pricing = [
    { modelPattern: "gpt-5", inputPerMillion: 1.25, outputPerMillion: 10, cachedPerMillion: 0.125 },
    { modelPattern: "gpt-5-codex", inputPerMillion: 2, outputPerMillion: 20, cachedPerMillion: 0.2 }
  ];

  it("prefers the most specific pattern", () => {
    // 1M uncached input at $2 + 0 output.
    expect(calculateCost({ inputTokens: 1_000_000, outputTokens: 0 }, "gpt-5-codex", pricing)).toBe(2);
  });

  it("bills the cached slice at the cached rate, not twice", () => {
    // 1M prompt tokens of which 500k cached: 500k * $2 + 500k * $0.2 per 1M.
    expect(
      calculateCost({ inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 500_000 }, "gpt-5-codex", pricing)
    ).toBe(1.1);
  });

  it("returns undefined for an unpriced model", () => {
    expect(calculateCost({ inputTokens: 100, outputTokens: 100 }, "unknown-model", pricing)).toBeUndefined();
  });
});
