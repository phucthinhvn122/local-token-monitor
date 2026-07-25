import type { ModelPricing, TokenUsageEvent } from "@ltm/shared-types";

export function estimateTokens(text: string, model?: string): { tokens: number; method: string } {
  // Content is never retained. This conservative fallback is intentionally
  // dependency-free and clearly marked as estimated.
  const utf8Bytes = Buffer.byteLength(text, "utf8");
  const divisor = /claude/i.test(model ?? "") ? 3.6 : 4;
  return {
    tokens: Math.max(1, Math.ceil(utf8Bytes / divisor)),
    method: `utf8-bytes/${divisor}`
  };
}

export function calculateCost(event: TokenUsageEvent, pricing: ModelPricing[]): number | undefined {
  const model = event.model ?? "";
  const provider = event.provider === "codex" ? "openai" : "anthropic";
  const match = pricing.find((item) => item.provider === provider && new RegExp(item.modelPattern, "i").test(model));
  if (!match) return undefined;
  const uncachedInputTokens = event.provider === "codex"
    ? Math.max(0, event.inputTokens - (event.cacheReadTokens ?? 0) - (event.cacheWriteTokens ?? 0))
    : event.inputTokens;
  const cost =
    (uncachedInputTokens * match.inputPerMillion +
      event.outputTokens * match.outputPerMillion +
      (event.cacheReadTokens ?? 0) * (match.cacheReadPerMillion ?? 0) +
      (event.cacheWriteTokens ?? 0) * (match.cacheWritePerMillion ?? 0)) /
    1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}
