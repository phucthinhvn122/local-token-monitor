import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderQuotaSnapshot, QuotaMetric } from "@ltm/shared-types";

export const DEFAULT_PUBLIC_MONTHLY_LIMIT = 100_000_000;

export interface PublicQuotaRelayConfig {
  enabled: boolean;
  endpoint: string;
  publishToken: string;
  monthlyLimit: number;
}

export interface PublicQuotaPayload {
  limit: number;
  used: number;
  observedAt: string;
}

export interface PublicQuotaRelayStatus {
  configured: boolean;
  state: "disabled" | "ready" | "publishing" | "published" | "error";
  endpoint?: string;
  lastPublishedAt?: string;
  lastError?: string;
}

export interface PublicQuotaPublisherOptions {
  config?: PublicQuotaRelayConfig;
  fetcher?: typeof fetch;
}

function publicHttpsEndpoint(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error("Public relay endpoint must be a public HTTPS URL without credentials or query parameters.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/api/quota")) {
    url.pathname = `${url.pathname}/api/quota`.replace(/\/{2,}/g, "/");
  }
  return url.toString();
}

export function parsePublicQuotaRelayConfig(value: unknown): PublicQuotaRelayConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Public relay configuration must be an object.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["enabled", "endpoint", "publishToken", "monthlyLimit"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("Public relay configuration contains an unsupported field.");
  }
  if (typeof record.endpoint !== "string") throw new Error("Public relay endpoint is required.");
  if (typeof record.publishToken !== "string" || record.publishToken.length < 24) {
    throw new Error("Public relay publish token must contain at least 24 characters.");
  }
  const monthlyLimit = record.monthlyLimit ?? DEFAULT_PUBLIC_MONTHLY_LIMIT;
  if (!Number.isSafeInteger(monthlyLimit) || (monthlyLimit as number) <= 0) {
    throw new Error("Public monthly limit must be a positive safe integer.");
  }
  return {
    enabled: record.enabled !== false,
    endpoint: publicHttpsEndpoint(record.endpoint),
    publishToken: record.publishToken,
    monthlyLimit: monthlyLimit as number
  };
}

export function publicQuotaRelayConfigPath(runtimeDir = path.join(os.homedir(), ".local-token-monitor")) {
  return path.join(runtimeDir, "public-relay.json");
}

export async function readPublicQuotaRelayConfig(
  runtimeDir = path.join(os.homedir(), ".local-token-monitor")
): Promise<PublicQuotaRelayConfig | undefined> {
  const environmentEndpoint = process.env.LTM_PUBLIC_QUOTA_RELAY_URL;
  const environmentToken = process.env.LTM_PUBLIC_QUOTA_PUBLISH_TOKEN;
  if (environmentEndpoint || environmentToken) {
    return parsePublicQuotaRelayConfig({
      enabled: true,
      endpoint: environmentEndpoint,
      publishToken: environmentToken,
      monthlyLimit: Number(process.env.LTM_NTTCODEX_MONTHLY_LIMIT || DEFAULT_PUBLIC_MONTHLY_LIMIT)
    });
  }
  try {
    const content = await readFile(publicQuotaRelayConfigPath(runtimeDir), "utf8");
    return parsePublicQuotaRelayConfig(JSON.parse(content));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function metricUsed(metric: QuotaMetric): number | undefined {
  if (metric.used !== undefined) return metric.used;
  if (metric.limit !== undefined && metric.remaining !== undefined) {
    return Math.max(0, metric.limit - metric.remaining);
  }
  return undefined;
}

export function sanitizedPublicQuotaPayload(
  snapshot: ProviderQuotaSnapshot,
  monthlyLimit = DEFAULT_PUBLIC_MONTHLY_LIMIT
): PublicQuotaPayload | undefined {
  if (snapshot.providerId !== "nttcodex" || !["available", "partial"].includes(snapshot.status)) {
    return undefined;
  }
  const monthlyMetrics = snapshot.metrics.filter(
    (metric) => metric.unit.toLowerCase().includes("token") && metric.window?.toLowerCase().includes("month")
  );
  const usedValues = monthlyMetrics.map(metricUsed).filter((value): value is number => value !== undefined);
  if (!usedValues.length) return undefined;
  const used = Math.round(usedValues.reduce((total, value) => total + value, 0));
  if (!Number.isSafeInteger(used) || used < 0) return undefined;
  return {
    limit: monthlyLimit,
    used,
    observedAt: snapshot.fetchedAt
  };
}

export class PublicQuotaPublisher {
  private readonly config?: PublicQuotaRelayConfig;
  private readonly fetcher: typeof fetch;
  private relayStatus: PublicQuotaRelayStatus;

  constructor(options: PublicQuotaPublisherOptions = {}) {
    this.config = options.config;
    this.fetcher = options.fetcher ?? fetch;
    this.relayStatus = this.config?.enabled
      ? { configured: true, state: "ready", endpoint: this.config.endpoint }
      : { configured: Boolean(this.config), state: "disabled" };
  }

  static async fromRuntime(runtimeDir?: string) {
    return new PublicQuotaPublisher({ config: await readPublicQuotaRelayConfig(runtimeDir) });
  }

  status(): PublicQuotaRelayStatus {
    return { ...this.relayStatus };
  }

  async publish(snapshot: ProviderQuotaSnapshot): Promise<boolean> {
    if (!this.config?.enabled) return false;
    const payload = sanitizedPublicQuotaPayload(snapshot, this.config.monthlyLimit);
    if (!payload) return false;
    this.relayStatus = {
      configured: true,
      state: "publishing",
      endpoint: this.config.endpoint,
      lastPublishedAt: this.relayStatus.lastPublishedAt
    };
    try {
      const response = await this.fetcher(this.config.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.publishToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(8_000)
      });
      if (response.body) await response.body.cancel().catch(() => undefined);
      if (!response.ok) throw new Error(`Relay returned HTTP ${response.status}.`);
      this.relayStatus = {
        configured: true,
        state: "published",
        endpoint: this.config.endpoint,
        lastPublishedAt: new Date().toISOString()
      };
      return true;
    } catch (error) {
      this.relayStatus = {
        configured: true,
        state: "error",
        endpoint: this.config.endpoint,
        lastPublishedAt: this.relayStatus.lastPublishedAt,
        lastError: error instanceof Error
          ? error.message.replaceAll(this.config.publishToken, "[REDACTED]")
          : "Public quota publishing failed."
      };
      return false;
    }
  }
}
