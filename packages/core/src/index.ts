import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Secret redaction, carried over from the original Local Token Monitor.
 * The gateway holds upstream pool credentials, so every string that can reach
 * a log line, an audit record or an API response passes through here first.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Non-capturing on purpose: the replacer below treats capture group 1 as a
  // field *label* to keep, so a capturing group here would echo the key back.
  /\bsk-[a-zA-Z0-9_-]{12,}\b/g,
  /\b(anthropic[_-]?(?:api[_-]?)?key)\s*[:=]\s*["']?([^\s"']+)/gi,
  /\bauthorization\s*[:=]\s*["']?Bearer\s+[^\s"',;]+/gi,
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie)\s*[:=]\s*["']?([^\s"',;]+)/gi,
  /\bBearer\s+[a-zA-Z0-9._~+/-]+=*/gi
];

export function redactSecrets(value: string): string {
  let safe = value;
  for (const pattern of SECRET_PATTERNS) {
    safe = safe.replace(pattern, (_match, label) => (label ? `${label}=[REDACTED]` : "[REDACTED]"));
  }
  safe = safe.replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, "C:\\Users\\[USER]");
  safe = safe.replace(/\/(?:Users|home)\/[^/\s]+/g, "/home/[USER]");
  return safe;
}

/** Never let a raw upstream error escape: redact, then bound the length. */
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).slice(0, 500);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time comparison for two hex digests of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Round to a whole non-negative token count. Upstreams occasionally send floats. */
export function toTokenCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed);
}
