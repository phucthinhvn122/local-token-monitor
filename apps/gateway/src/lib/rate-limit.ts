/**
 * Per-key sliding-window rate limiting and concurrency capping.
 *
 * In-memory by design for the single-instance Docker Compose deployment this
 * project targets. Every limit is enforced per process, so running multiple
 * gateway replicas multiplies the effective ceiling. Swapping the two stores
 * below for Redis (`ZADD`/`ZCOUNT` for the window, `INCR`/`DECR` for
 * concurrency) is the documented path to horizontal scale.
 */

interface Window {
  /** Request timestamps in ms, ascending. */
  hits: number[];
}

const WINDOW_MS = 60_000;

const windows = new Map<string, Window>();
const concurrency = new Map<string, number>();

export interface LimitDecision {
  allowed: boolean;
  reason?: "rate" | "concurrency";
  /** Seconds the caller should wait, for the Retry-After header. */
  retryAfterSeconds?: number;
  remaining: number;
}

export function checkRateLimit(key: string, limitPerMinute: number, now = Date.now()): LimitDecision {
  if (limitPerMinute <= 0) return { allowed: true, remaining: Number.POSITIVE_INFINITY };

  const window = windows.get(key) ?? { hits: [] };
  const cutoff = now - WINDOW_MS;
  // Timestamps are appended in order, so dropping the expired prefix is enough.
  let firstLive = 0;
  while (firstLive < window.hits.length && window.hits[firstLive] <= cutoff) firstLive++;
  if (firstLive > 0) window.hits = window.hits.slice(firstLive);

  if (window.hits.length >= limitPerMinute) {
    windows.set(key, window);
    const retryAfterSeconds = Math.max(1, Math.ceil((window.hits[0] + WINDOW_MS - now) / 1000));
    return { allowed: false, reason: "rate", retryAfterSeconds, remaining: 0 };
  }

  window.hits.push(now);
  windows.set(key, window);
  return { allowed: true, remaining: limitPerMinute - window.hits.length };
}

export function acquireSlot(key: string, maxConcurrent: number): boolean {
  if (maxConcurrent <= 0) return true;
  const current = concurrency.get(key) ?? 0;
  if (current >= maxConcurrent) return false;
  concurrency.set(key, current + 1);
  return true;
}

export function releaseSlot(key: string): void {
  const current = concurrency.get(key) ?? 0;
  if (current <= 1) concurrency.delete(key);
  else concurrency.set(key, current - 1);
}

export function activeConcurrency(key: string): number {
  return concurrency.get(key) ?? 0;
}

/** Drop windows that have gone quiet, so the map cannot grow unbounded. */
export function sweepRateLimitState(now = Date.now()): void {
  const cutoff = now - WINDOW_MS;
  for (const [key, window] of windows) {
    if (window.hits.length === 0 || window.hits[window.hits.length - 1] <= cutoff) windows.delete(key);
  }
}

export function resetRateLimitState(): void {
  windows.clear();
  concurrency.clear();
}
