import { beforeEach, describe, expect, it } from "vitest";
import { burnRatePerDay, buildQuotaSummary, hasQuota, tokenRemaining, usedPercent } from "../apps/gateway/src/lib/quota.js";
import {
  acquireSlot,
  activeConcurrency,
  checkRateLimit,
  releaseSlot,
  resetRateLimitState,
  sweepRateLimitState
} from "../apps/gateway/src/lib/rate-limit.js";
import { quotaLevel } from "../packages/shared/src/index.js";

describe("quota arithmetic", () => {
  it("reports the remaining balance", () => {
    expect(tokenRemaining({ tokenQuota: 2_000_000, tokenUsed: 750_000 })).toBe(1_250_000);
  });

  it("never reports a negative remainder after an overshoot", () => {
    expect(tokenRemaining({ tokenQuota: 100, tokenUsed: 250 })).toBe(0);
  });

  it("computes the used percentage to one decimal", () => {
    expect(usedPercent({ tokenQuota: 2_000_000, tokenUsed: 500_000 })).toBe(25);
    expect(usedPercent({ tokenQuota: 3, tokenUsed: 1 })).toBe(33.3);
  });

  it("caps the percentage at 100 when usage exceeds the grant", () => {
    expect(usedPercent({ tokenQuota: 100, tokenUsed: 250 })).toBe(100);
  });

  it("treats a zero grant as fully consumed once anything is spent", () => {
    expect(usedPercent({ tokenQuota: 0, tokenUsed: 0 })).toBe(0);
    expect(usedPercent({ tokenQuota: 0, tokenUsed: 5 })).toBe(100);
  });
});

describe("admission control", () => {
  it("admits a key with quota left", () => {
    expect(hasQuota({ tokenQuota: 1000, tokenUsed: 999 })).toBe(true);
  });

  it("rejects a key that has reached its grant", () => {
    expect(hasQuota({ tokenQuota: 1000, tokenUsed: 1000 })).toBe(false);
    expect(hasQuota({ tokenQuota: 1000, tokenUsed: 1200 })).toBe(false);
  });

  it("rejects a key with no grant at all", () => {
    expect(hasQuota({ tokenQuota: 0, tokenUsed: 0 })).toBe(false);
  });
});

describe("deduction accounting", () => {
  /**
   * Mirrors the relative `increment` the gateway issues. The point of the
   * increment is that interleaved requests cannot lose an update the way a
   * read-modify-write would, so the order of settlement must not matter.
   */
  function applyCharges(start: number, charges: number[]): number {
    return charges.reduce((used, amount) => used + amount, start);
  }

  it("sums sequential charges exactly", () => {
    expect(applyCharges(0, [140, 260, 600])).toBe(1000);
  });

  it("reaches the same total regardless of settlement order", () => {
    const charges = [140, 260, 600, 17, 3];
    const forward = applyCharges(0, charges);
    const reversed = applyCharges(0, [...charges].reverse());
    expect(forward).toBe(reversed);
  });

  it("allows at most one request to overshoot the grant", () => {
    // The gate is "has any quota left", so the last admitted request may push
    // usage past the grant — but the next one is refused.
    const state = { tokenQuota: 1000, tokenUsed: 990 };
    expect(hasQuota(state)).toBe(true);
    state.tokenUsed = applyCharges(state.tokenUsed, [500]);
    expect(state.tokenUsed).toBe(1490);
    expect(hasQuota(state)).toBe(false);
  });
});

describe("quota level thresholds", () => {
  it("is safe well above the warning line", () => {
    expect(quotaLevel(50, 10)).toBe("safe");
    expect(quotaLevel(89, 10)).toBe("safe");
  });

  it("warns once the remainder drops to the configured percentage", () => {
    expect(quotaLevel(90, 10)).toBe("warning");
    expect(quotaLevel(94, 10)).toBe("warning");
  });

  it("escalates to critical at half the warning threshold", () => {
    expect(quotaLevel(95, 10)).toBe("critical");
    expect(quotaLevel(99.9, 10)).toBe("critical");
  });

  it("reports depletion at 100 percent", () => {
    expect(quotaLevel(100, 10)).toBe("depleted");
  });

  it("honours a custom warning percentage", () => {
    expect(quotaLevel(80, 25)).toBe("warning");
    expect(quotaLevel(80, 10)).toBe("safe");
  });
});

describe("burn rate and projection", () => {
  const daily = (values: number[]) =>
    values.map((totalTokens, index) => ({ bucket: `2026-01-${String(index + 1).padStart(2, "0")}`, totalTokens }));

  it("averages over the observed span, including idle days", () => {
    // 4 days totalling 400 tokens, one of them idle.
    expect(burnRatePerDay(daily([100, 100, 0, 200]))).toBe(100);
  });

  it("returns zero when nothing has been consumed", () => {
    expect(burnRatePerDay(daily([0, 0, 0]))).toBe(0);
    expect(burnRatePerDay([])).toBe(0);
  });

  it("projects the days remaining from the burn rate", () => {
    const summary = buildQuotaSummary({ tokenQuota: 1000, tokenUsed: 400 }, daily([100, 100, 100, 100]), 10);
    expect(summary.dailyBurnRate).toBe(100);
    expect(summary.estimatedDaysRemaining).toBe(6);
  });

  it("gives no projection without a burn rate", () => {
    const summary = buildQuotaSummary({ tokenQuota: 1000, tokenUsed: 0 }, daily([0, 0]), 10);
    expect(summary.estimatedDaysRemaining).toBeNull();
  });

  it("gives no projection once the quota is gone", () => {
    const summary = buildQuotaSummary({ tokenQuota: 1000, tokenUsed: 1000 }, daily([500, 500]), 10);
    expect(summary.estimatedDaysRemaining).toBeNull();
    expect(summary.level).toBe("depleted");
  });
});

describe("rate limiting", () => {
  beforeEach(() => resetRateLimitState());

  it("allows requests up to the limit and refuses the next one", () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) expect(checkRateLimit("key", 3, now).allowed).toBe(true);
    const blocked = checkRateLimit("key", 3, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("rate");
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("lets the window slide", () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) checkRateLimit("key", 3, now);
    expect(checkRateLimit("key", 3, now).allowed).toBe(false);
    // One minute and a tick later the earlier hits have expired.
    expect(checkRateLimit("key", 3, now + 60_001).allowed).toBe(true);
  });

  it("keeps separate budgets per key", () => {
    const now = Date.now();
    checkRateLimit("a", 1, now);
    expect(checkRateLimit("a", 1, now).allowed).toBe(false);
    expect(checkRateLimit("b", 1, now).allowed).toBe(true);
  });

  it("treats a limit of zero as unlimited", () => {
    for (let i = 0; i < 100; i++) expect(checkRateLimit("key", 0).allowed).toBe(true);
  });

  it("forgets idle keys during the sweep", () => {
    const now = Date.now();
    checkRateLimit("stale", 5, now);
    sweepRateLimitState(now + 120_000);
    // A fresh window means the full budget is available again.
    expect(checkRateLimit("stale", 5, now + 120_000).remaining).toBe(4);
  });
});

describe("concurrency capping", () => {
  beforeEach(() => resetRateLimitState());

  it("refuses a slot beyond the cap and frees it on release", () => {
    expect(acquireSlot("key", 2)).toBe(true);
    expect(acquireSlot("key", 2)).toBe(true);
    expect(acquireSlot("key", 2)).toBe(false);

    releaseSlot("key");
    expect(acquireSlot("key", 2)).toBe(true);
  });

  it("returns to zero once every slot is released", () => {
    acquireSlot("key", 3);
    acquireSlot("key", 3);
    releaseSlot("key");
    releaseSlot("key");
    expect(activeConcurrency("key")).toBe(0);
  });

  it("treats a cap of zero as unlimited", () => {
    for (let i = 0; i < 50; i++) expect(acquireSlot("key", 0)).toBe(true);
  });
});
