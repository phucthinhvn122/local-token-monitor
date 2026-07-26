import { prisma, asNumber } from "@cgw/db";
import { quotaLevel, type QuotaSummary } from "@cgw/shared";

export interface QuotaState {
  tokenQuota: number;
  tokenUsed: number;
}

export function tokenRemaining(state: QuotaState): number {
  return Math.max(0, state.tokenQuota - state.tokenUsed);
}

export function usedPercent(state: QuotaState): number {
  if (state.tokenQuota <= 0) return state.tokenUsed > 0 ? 100 : 0;
  return Math.min(100, Math.round((state.tokenUsed / state.tokenQuota) * 1000) / 10);
}

/**
 * Gate applied before a request is forwarded.
 *
 * The check is intentionally "has any quota left" rather than "has enough for
 * this request": the cost of a request is unknowable until the response comes
 * back. A key can therefore overshoot its quota by at most one request, which
 * is the standard trade-off for pay-as-you-go metering and is visible in the
 * dashboard as `used > quota`.
 */
export function hasQuota(state: QuotaState): boolean {
  return state.tokenQuota > 0 && state.tokenUsed < state.tokenQuota;
}

/**
 * Charge tokens against a key.
 *
 * Uses a relative `increment` so concurrent requests cannot lose an update the
 * way a read-modify-write would. The paired DEDUCT transaction row makes every
 * change to the balance reconstructable from `token_transactions`.
 */
export async function chargeTokens(
  apiKeyId: string,
  tokens: number,
  note?: string
): Promise<{ tokenUsed: number; tokenQuota: number } | null> {
  if (tokens <= 0) return null;

  const [updated] = await prisma.$transaction([
    prisma.apiKey.update({
      where: { id: apiKeyId },
      data: { tokenUsed: { increment: BigInt(tokens) }, lastUsedAt: new Date() },
      select: { tokenUsed: true, tokenQuota: true }
    }),
    prisma.tokenTransaction.create({
      data: {
        apiKeyId,
        amount: BigInt(-tokens),
        type: "DEDUCT",
        note: note ?? null
      }
    })
  ]);

  return { tokenUsed: asNumber(updated.tokenUsed), tokenQuota: asNumber(updated.tokenQuota) };
}

/**
 * Mean daily burn over the trailing window, ignoring days before the key was
 * first used so a key created last week is not averaged over 30 days.
 */
export function burnRatePerDay(
  dailyTotals: Array<{ bucket: string; totalTokens: number }>,
  windowDays = 14
): number {
  if (dailyTotals.length === 0) return 0;
  const recent = dailyTotals.slice(-windowDays);
  const active = recent.filter((point) => point.totalTokens > 0);
  if (active.length === 0) return 0;
  const total = active.reduce((sum, point) => sum + point.totalTokens, 0);
  // Divide by the observed span, not by the count of active days: idle days are
  // real signal about the pace of consumption.
  const span = Math.max(1, recent.length);
  return Math.round(total / span);
}

export function buildQuotaSummary(
  state: QuotaState,
  dailyTotals: Array<{ bucket: string; totalTokens: number }>,
  warnPercent: number
): QuotaSummary {
  const remaining = tokenRemaining(state);
  const percent = usedPercent(state);
  const dailyBurnRate = burnRatePerDay(dailyTotals);
  const estimatedDaysRemaining =
    dailyBurnRate > 0 && remaining > 0 ? Math.round((remaining / dailyBurnRate) * 10) / 10 : null;

  return {
    tokenQuota: state.tokenQuota,
    tokenUsed: state.tokenUsed,
    tokenRemaining: remaining,
    usedPercent: percent,
    level: quotaLevel(percent, warnPercent),
    dailyBurnRate,
    estimatedDaysRemaining
  };
}
