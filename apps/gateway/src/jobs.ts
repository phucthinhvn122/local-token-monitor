import type { FastifyInstance } from "fastify";
import { prisma } from "@cgw/db";
import { safeError } from "@cgw/core";
import { env } from "./env.js";
import { decryptSecret, parseEncryptionKey } from "./lib/crypto.js";
import { loadSettings } from "./lib/settings.js";
import { probeProvider } from "./lib/upstream.js";
import { sweepRateLimitState } from "./lib/rate-limit.js";

/**
 * Periodic pool health check. Doubles as the circuit-breaker recovery path: a
 * provider whose probe succeeds gets its breaker cleared, so it rejoins the
 * rotation without waiting for a request to gamble on it.
 */
export async function runHealthChecks(app: FastifyInstance): Promise<void> {
  const encryptionKey = parseEncryptionKey(env().ENCRYPTION_KEY);
  const providers = await prisma.poolProvider.findMany({ where: { isActive: true } });

  await Promise.all(
    providers.map(async (provider) => {
      try {
        const result = await probeProvider({
          baseUrl: provider.baseUrl,
          apiKey: decryptSecret(provider.apiKeyEncrypted, encryptionKey),
          timeoutMs: 15_000
        });
        await prisma.poolProvider.update({
          where: { id: provider.id },
          data: {
            lastHealthCheck: new Date(),
            lastHealthOk: result.ok,
            lastHealthLatency: result.latencyMs,
            ...(result.ok
              ? { consecutiveErrors: 0, circuitOpenUntil: null }
              : { lastErrorAt: new Date(), lastErrorMessage: result.message.slice(0, 500) })
          }
        });
      } catch (error) {
        app.log.warn({ provider: provider.name, error: safeError(error) }, "Health check failed");
      }
    })
  );
}

/** Delete usage and audit rows older than the configured retention window. */
export async function runRetentionSweep(app: FastifyInstance): Promise<void> {
  const settings = await loadSettings(true);
  const cutoff = new Date(Date.now() - settings.logRetentionDays * 86_400_000);

  const [usage, audit, sessions] = await Promise.all([
    prisma.usageLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.adminAuditLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } })
  ]);

  if (usage.count || audit.count || sessions.count) {
    app.log.info(
      { usageLogs: usage.count, auditLogs: audit.count, expiredSessions: sessions.count, retentionDays: settings.logRetentionDays },
      "Retention sweep complete"
    );
  }
}

export function startBackgroundJobs(app: FastifyInstance): () => void {
  const config = env();
  if (!config.ENABLE_BACKGROUND_JOBS) return () => undefined;

  const guard = (name: string, task: () => Promise<void>) => () => {
    void task().catch((error) => app.log.error({ job: name, error: safeError(error) }, "Background job failed"));
  };

  const health = setInterval(guard("health-check", () => runHealthChecks(app)), config.HEALTH_CHECK_INTERVAL_MS);
  const retention = setInterval(
    guard("retention", () => runRetentionSweep(app)),
    config.RETENTION_SWEEP_INTERVAL_MS
  );
  const sweep = setInterval(() => sweepRateLimitState(), 60_000);

  // Do not hold the process open just for timers.
  for (const timer of [health, retention, sweep]) timer.unref?.();

  // First pass shortly after boot, once the server is accepting traffic.
  const warmup = setTimeout(guard("health-check", () => runHealthChecks(app)), 5_000);
  warmup.unref?.();

  return () => {
    clearInterval(health);
    clearInterval(retention);
    clearInterval(sweep);
    clearTimeout(warmup);
  };
}
