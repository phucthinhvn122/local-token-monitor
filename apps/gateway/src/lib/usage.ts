import { toTokenCount } from "@cgw/core";

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

export const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  totalTokens: 0
};

/**
 * Normalize a `usage` object from either wire protocol.
 *
 *  - Chat Completions: `prompt_tokens` / `completion_tokens` /
 *    `prompt_tokens_details.cached_tokens`
 *  - Responses API:    `input_tokens` / `output_tokens` /
 *    `input_tokens_details.cached_tokens`
 *
 * When the upstream supplies `total_tokens` it wins, because some providers
 * bill components the response does not itemise.
 */
export function normalizeUsage(raw: unknown): NormalizedUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;

  const inputTokens = toTokenCount(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = toTokenCount(usage.completion_tokens ?? usage.output_tokens);

  const promptDetails = (usage.prompt_tokens_details ?? usage.input_tokens_details) as
    | Record<string, unknown>
    | undefined;
  const cachedTokens = toTokenCount(
    promptDetails?.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens
  );

  const reported = toTokenCount(usage.total_tokens);
  const totalTokens = reported > 0 ? reported : inputTokens + outputTokens;

  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return null;
  return { inputTokens, outputTokens, cachedTokens, totalTokens };
}

/**
 * Pull usage out of a complete (non-streaming) response body. The Responses API
 * nests it under `response` in some shapes, so both are checked.
 */
export function usageFromBody(body: unknown): NormalizedUsage | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  return (
    normalizeUsage(record.usage) ??
    normalizeUsage((record.response as Record<string, unknown> | undefined)?.usage)
  );
}

/* --------------------------------------------------------------- streaming */

export interface SseEvent {
  /** Raw text of the whole event block, including the trailing blank line. */
  raw: string;
  /** Value of the `data:` field, joined across multiple data lines. */
  data: string | null;
  /** Value of the `event:` field, if present. */
  event: string | null;
}

/** Split a buffered chunk of SSE text into complete events plus a remainder. */
export function parseSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buffer;

  // Events are separated by a blank line; tolerate both \n\n and \r\n\r\n.
  const separator = /\r?\n\r?\n/;
  let match = separator.exec(rest);
  while (match) {
    const block = rest.slice(0, match.index);
    const raw = rest.slice(0, match.index + match[0].length);
    rest = rest.slice(match.index + match[0].length);

    const dataLines: string[] = [];
    let eventName: string | null = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      else if (line.startsWith("event:")) eventName = line.slice(6).trim();
    }
    events.push({ raw, data: dataLines.length ? dataLines.join("\n") : null, event: eventName });
    match = separator.exec(rest);
  }

  return { events, rest };
}

/**
 * Decide what a single SSE event contributes.
 *
 * `usageOnly` marks a Chat Completions chunk that carries usage and nothing
 * else (`choices: []`). Those chunks only exist because the gateway injected
 * `stream_options.include_usage`, so when the client did not ask for them they
 * are dropped from the forwarded stream rather than changing what the client
 * sees.
 */
export function inspectSseEvent(event: SseEvent): {
  usage: NormalizedUsage | null;
  usageOnly: boolean;
  outputText: string;
} {
  if (!event.data || event.data === "[DONE]") return { usage: null, usageOnly: false, outputText: "" };

  let payload: unknown;
  try {
    payload = JSON.parse(event.data);
  } catch {
    return { usage: null, usageOnly: false, outputText: "" };
  }

  const record = payload as Record<string, unknown>;
  const usage = usageFromBody(record);

  const choices = record.choices;
  const usageOnly = Boolean(usage) && Array.isArray(choices) && choices.length === 0;

  return { usage, usageOnly, outputText: collectStreamText(record) };
}

/** Best-effort text extraction, used only for the estimated-token fallback. */
function collectStreamText(record: Record<string, unknown>): string {
  // Chat Completions delta
  const choices = record.choices;
  if (Array.isArray(choices)) {
    const parts: string[] = [];
    for (const choice of choices) {
      const delta = (choice as Record<string, unknown>)?.delta as Record<string, unknown> | undefined;
      if (typeof delta?.content === "string") parts.push(delta.content);
      const toolCalls = delta?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          const args = ((call as Record<string, unknown>)?.function as Record<string, unknown>)?.arguments;
          if (typeof args === "string") parts.push(args);
        }
      }
    }
    return parts.join("");
  }
  // Responses API incremental text
  if (typeof record.delta === "string") return record.delta;
  return "";
}

/**
 * Ensure a streaming Chat Completions request asks for usage. Returns the body
 * to forward plus whether the client had already requested it, so the caller
 * knows if the usage-only chunk must be filtered back out.
 */
export function withUsageReporting(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  clientRequestedUsage: boolean;
} {
  const existing = body.stream_options as Record<string, unknown> | undefined;
  const clientRequestedUsage = existing?.include_usage === true;
  if (clientRequestedUsage) return { body, clientRequestedUsage };
  return {
    body: { ...body, stream_options: { ...(existing ?? {}), include_usage: true } },
    clientRequestedUsage
  };
}
