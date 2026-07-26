import { prisma } from "@cgw/db";
import type { PricingRow } from "@cgw/token-estimator";

export type SystemSettings = Awaited<ReturnType<typeof loadSettings>>;

const SETTINGS_ID = 1;
/** Settings are read on every proxied request; a short TTL keeps that cheap. */
const CACHE_TTL_MS = 5_000;

let cache: { value: Awaited<ReturnType<typeof readSettings>>; expiresAt: number } | null = null;
let pricingCache: { value: PricingRow[]; expiresAt: number } | null = null;

async function readSettings() {
  return prisma.systemSetting.upsert({
    where: { id: SETTINGS_ID },
    update: {},
    create: { id: SETTINGS_ID }
  });
}

export async function loadSettings(force = false) {
  if (!force && cache && cache.expiresAt > Date.now()) return cache.value;
  const value = await readSettings();
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export function invalidateSettingsCache(): void {
  cache = null;
}

export async function loadPricing(force = false): Promise<PricingRow[]> {
  if (!force && pricingCache && pricingCache.expiresAt > Date.now()) return pricingCache.value;
  const rows = await prisma.modelPricing.findMany();
  const value: PricingRow[] = rows.map((row) => ({
    modelPattern: row.modelPattern,
    inputPerMillion: Number(row.inputPerMillion),
    outputPerMillion: Number(row.outputPerMillion),
    cachedPerMillion: row.cachedPerMillion === null ? null : Number(row.cachedPerMillion)
  }));
  pricingCache = { value, expiresAt: Date.now() + CACHE_TTL_MS * 12 };
  return value;
}

export function invalidatePricingCache(): void {
  pricingCache = null;
}
