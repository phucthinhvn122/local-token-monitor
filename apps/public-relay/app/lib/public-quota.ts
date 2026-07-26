export const PUBLIC_QUOTA_WINDOW = "month" as const;
export const PUBLIC_QUOTA_UNIT = "tokens" as const;
export const DEFAULT_MONTHLY_LIMIT = 100_000_000;
export const STALE_AFTER_MS = 5 * 60_000;

export interface PublicQuotaWrite {
  limit: number;
  used: number;
  observedAt: string;
}

export interface StoredQuotaSnapshot extends PublicQuotaWrite {
  remaining: number;
  publishedAt: string;
}

export interface PublicQuotaSnapshot extends StoredQuotaSnapshot {
  status: "active" | "near-limit" | "exhausted" | "stale";
  window: typeof PUBLIC_QUOTA_WINDOW;
  unit: typeof PUBLIC_QUOTA_UNIT;
  percentUsed: number;
}

export type PublicQuotaResponse =
  | { status: "waiting"; window: typeof PUBLIC_QUOTA_WINDOW; unit: typeof PUBLIC_QUOTA_UNIT }
  | PublicQuotaSnapshot;

const ALLOWED_WRITE_KEYS = new Set(["limit", "used", "observedAt"]);
const MAX_LIMIT = 1_000_000_000_000;
const MAX_USED = 10_000_000_000_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parsePublicQuotaWrite(value: unknown, now = Date.now()): PublicQuotaWrite {
  if (!isPlainRecord(value)) {
    throw new Error("Payload must be a JSON object.");
  }

  const keys = Object.keys(value);
  if (keys.some((key) => !ALLOWED_WRITE_KEYS.has(key)) || keys.length !== ALLOWED_WRITE_KEYS.size) {
    throw new Error("Payload must contain only limit, used, and observedAt.");
  }

  const limit = value.limit;
  const used = value.used;
  const observedAt = value.observedAt;
  if (!Number.isSafeInteger(limit) || (limit as number) <= 0 || (limit as number) > MAX_LIMIT) {
    throw new Error("limit must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(used) || (used as number) < 0 || (used as number) > MAX_USED) {
    throw new Error("used must be a non-negative safe integer.");
  }
  if (typeof observedAt !== "string") {
    throw new Error("observedAt must be an ISO timestamp.");
  }

  const observedTime = Date.parse(observedAt);
  if (!Number.isFinite(observedTime) || new Date(observedTime).toISOString() !== observedAt) {
    throw new Error("observedAt must be an ISO timestamp.");
  }
  if (observedTime > now + 10 * 60_000) {
    throw new Error("observedAt cannot be more than 10 minutes in the future.");
  }

  return { limit: limit as number, used: used as number, observedAt };
}

export function toStoredQuotaSnapshot(
  write: PublicQuotaWrite,
  publishedAt = new Date().toISOString()
): StoredQuotaSnapshot {
  return {
    ...write,
    remaining: Math.max(0, write.limit - write.used),
    publishedAt
  };
}

export function toPublicQuotaSnapshot(
  stored: StoredQuotaSnapshot,
  now = Date.now()
): PublicQuotaSnapshot {
  const percentUsed = Math.round((stored.used / stored.limit) * 10_000) / 100;
  const stale = now - Date.parse(stored.observedAt) > STALE_AFTER_MS;
  const status = stale
    ? "stale"
    : stored.remaining === 0
      ? "exhausted"
      : percentUsed >= 90
        ? "near-limit"
        : "active";

  return {
    status,
    window: PUBLIC_QUOTA_WINDOW,
    unit: PUBLIC_QUOTA_UNIT,
    limit: stored.limit,
    used: stored.used,
    remaining: stored.remaining,
    percentUsed,
    observedAt: stored.observedAt,
    publishedAt: stored.publishedAt
  };
}

export async function tokensMatch(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}
