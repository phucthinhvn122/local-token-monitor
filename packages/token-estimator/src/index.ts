/**
 * Local token estimation, used only when an upstream provider does not return
 * a `usage` object. Values produced here are always recorded with
 * `accuracy: "estimated"` so the dashboards never present them as exact.
 *
 * The heuristic is intentionally dependency-free: pulling a real BPE tokenizer
 * into the request path would add tens of megabytes and a per-request CPU cost
 * for a fallback that should be rare.
 */

export interface PricingRow {
  modelPattern: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedPerMillion?: number | null;
}

export interface EstimateResult {
  tokens: number;
  method: string;
}

const DIVISOR_DEFAULT = 4;
const DIVISOR_CLAUDE = 3.6;

export function estimateTokens(text: string, model?: string): EstimateResult {
  if (!text) return { tokens: 0, method: "empty" };
  const utf8Bytes = Buffer.byteLength(text, "utf8");
  const divisor = /claude/i.test(model ?? "") ? DIVISOR_CLAUDE : DIVISOR_DEFAULT;
  return { tokens: Math.max(1, Math.ceil(utf8Bytes / divisor)), method: `utf8-bytes/${divisor}` };
}

/**
 * Collect every piece of user-visible text out of an OpenAI-style request body,
 * covering both `messages` (Chat Completions) and `input` (Responses API), with
 * the string / content-part / nested-array shapes each of them allows.
 */
export function extractRequestText(body: unknown): string {
  const parts: string[] = [];

  const walkContent = (content: unknown): void => {
    if (typeof content === "string") {
      parts.push(content);
      return;
    }
    if (Array.isArray(content)) {
      for (const item of content) walkContent(item);
      return;
    }
    if (content && typeof content === "object") {
      const record = content as Record<string, unknown>;
      if (typeof record.text === "string") parts.push(record.text);
      if (typeof record.content === "string" || Array.isArray(record.content)) walkContent(record.content);
      // Tool call arguments are billed as input too.
      if (typeof record.arguments === "string") parts.push(record.arguments);
    }
  };

  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.instructions === "string") parts.push(record.instructions);
    if (Array.isArray(record.messages)) for (const message of record.messages) walkContent(message);
    if (record.input !== undefined) walkContent(record.input);
    if (Array.isArray(record.tools)) parts.push(JSON.stringify(record.tools));
  }

  return parts.join("\n");
}

export function estimateRequestTokens(body: unknown, model?: string): EstimateResult {
  return estimateTokens(extractRequestText(body), model);
}

/** Longest pattern wins, so `gpt-5-codex` beats a generic `gpt-5` row. */
export function matchPricing(model: string | null | undefined, pricing: PricingRow[]): PricingRow | undefined {
  if (!model) return undefined;
  return pricing
    .filter((row) => {
      try {
        return new RegExp(row.modelPattern, "i").test(model);
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.modelPattern.length - a.modelPattern.length)[0];
}

export function calculateCost(
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number },
  model: string | null | undefined,
  pricing: PricingRow[]
): number | undefined {
  const row = matchPricing(model, pricing);
  if (!row) return undefined;
  const cached = usage.cachedTokens ?? 0;
  // Providers report `prompt_tokens` inclusive of the cached portion, so the
  // cached slice is billed at its own rate and removed from the full-price side.
  const uncachedInput = Math.max(0, usage.inputTokens - cached);
  const cost =
    (uncachedInput * row.inputPerMillion +
      usage.outputTokens * row.outputPerMillion +
      cached * (row.cachedPerMillion ?? 0)) /
    1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}
