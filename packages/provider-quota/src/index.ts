import type {
  ProviderCapabilities,
  ProviderDetectionResult,
  ProviderQuotaDiagnostics,
  ProviderQuotaSnapshot,
  QuotaEvidence,
  QuotaFetchContext,
  QuotaMetric,
  QuotaProviderAdapter,
  ThirdPartyProviderConfig,
  ThirdPartyProviderId
} from "@ltm/shared-types";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export {
  NttCodexBrowserBridge,
  parseNttCodexAccountKeys,
  type NttCodexBrowserBridgeOptions,
  type NttCodexBrowserStatus
} from "./nttcodex-browser.js";

export {
  discoverAntigravityAuthTokens,
  discoverCodexAuthTokens,
  fetchAntigravityQuotaStatus,
  fetchNxtCodexQuotaStatus,
  maskApiKey,
  parseHeaderValue,
  parseResetTimestamp,
  type CodexAuthData,
  type NxtCodexQuotaOptions
} from "./nxtcodex.js";

export interface ProviderResearchRecord {
  providerId: ThirdPartyProviderId;
  domain: string;
  domainStatus: "verified" | "unverified";
  publicBaseUrl?: string;
  quotaEndpoint?: string;
  protocols: Array<"openai" | "anthropic">;
  inferenceEndpoints: string[];
  quotaEndpointVerified: boolean;
  dashboardAvailable: boolean;
  automationAllowed: "not-documented" | "restricted" | "unknown";
  notes: string[];
  evidence: QuotaEvidence[];
}

const observedAt = "2026-07-25T05:22:03.000Z";

export const providerResearch: Record<ThirdPartyProviderId, ProviderResearchRecord> = {
  nxtcodex: {
    providerId: "nxtcodex",
    domain: "nxtcodex.com",
    domainStatus: "verified",
    publicBaseUrl: "https://nxtcodex.com/v1",
    protocols: ["openai"],
    inferenceEndpoints: ["/v1/chat/completions", "/v1/models"],
    quotaEndpointVerified: false,
    dashboardAvailable: true,
    automationAllowed: "not-documented",
    notes: [
      "Official site documents API key usage, credit packages, and usage status.",
      "Automatically scans Codex auth.json (~/.codex/auth.json) if environment key is missing.",
      "Reads response headers (x-ratelimit-*) and JSON body structures."
    ],
    evidence: [
      {
        kind: "official-doc",
        label: "NXTCODEX Official Site",
        url: "https://nxtcodex.com/",
        isOfficial: true,
        observedAt
      }
    ]
  },
  antigravity: {
    providerId: "antigravity",
    domain: "antigravity.dev",
    domainStatus: "verified",
    publicBaseUrl: "https://api.antigravity.dev/v1",
    protocols: ["openai"],
    inferenceEndpoints: ["/v1/chat/completions", "/v1/models"],
    quotaEndpointVerified: false,
    dashboardAvailable: true,
    automationAllowed: "not-documented",
    notes: [
      "Scans local Antigravity configuration and credentials (~/.gemini/antigravity).",
      "Parses response headers (x-ratelimit-*) and official quota endpoints."
    ],
    evidence: [
      {
        kind: "official-doc",
        label: "Antigravity Official Environment",
        url: "https://antigravity.dev/",
        isOfficial: true,
        observedAt
      }
    ]
  },
  freemodel: {
    providerId: "freemodel",
    domain: "freemodel.dev",
    domainStatus: "verified",
    publicBaseUrl: "https://api.freemodel.dev/v1",
    protocols: ["openai", "anthropic"],
    inferenceEndpoints: ["/v1/responses", "/v1/chat/completions", "/v1/messages"],
    quotaEndpointVerified: false,
    dashboardAvailable: true,
    automationAllowed: "restricted",
    notes: [
      "The official site documents inference endpoints and a usage dashboard, but no public quota or balance API endpoint was found.",
      "Terms prohibit automated attacks, scraping, and circumvention; dashboard scraping is disabled."
    ],
    evidence: [
      {
        kind: "official-doc",
        label: "FreeModel official product and API page",
        url: "https://freemodel.dev/",
        isOfficial: true,
        observedAt
      },
      {
        kind: "official-doc",
        label: "FreeModel privacy policy",
        url: "https://freemodel.dev/privacy",
        isOfficial: true,
        observedAt
      },
      {
        kind: "official-doc",
        label: "FreeModel terms of service",
        url: "https://freemodel.dev/terms",
        isOfficial: true,
        observedAt
      }
    ]
  },
  nttcodex: {
    providerId: "nttcodex",
    domain: "nttcodex.com",
    domainStatus: "verified",
    publicBaseUrl: "https://nttcodex.com/v1",
    quotaEndpoint: "https://nttcodex.com/account/keys",
    protocols: [],
    inferenceEndpoints: [],
    quotaEndpointVerified: false,
    dashboardAvailable: true,
    automationAllowed: "not-documented",
    notes: [
      "The official public site describes API keys, package quota, token history, and a /v1 base URL in its public page configuration.",
      "The official account UI reads GET /account/keys with the signed-in web session. The optional local browser bridge can aggregate its quota fields without importing cookie values."
    ],
    evidence: [
      {
        kind: "official-doc",
        label: "NTTCodex official public site",
        url: "https://nttcodex.com/",
        isOfficial: true,
        observedAt
      },
      {
        kind: "official-doc",
        label: "NTTCodex public usage guide",
        url: "https://nttcodex.com/user/huong-dan",
        isOfficial: true,
        observedAt
      },
      {
        kind: "provider-dashboard",
        label: "NTTCodex account keys dashboard endpoint",
        url: "https://nttcodex.com/account/keys",
        isOfficial: true,
        observedAt
      }
    ]
  },
  "openai-compatible": {
    providerId: "openai-compatible",
    domain: "",
    domainStatus: "unverified",
    protocols: ["openai"],
    inferenceEndpoints: [],
    quotaEndpointVerified: false,
    dashboardAvailable: false,
    automationAllowed: "unknown",
    notes: ["User-configured provider. Only explicit response headers and usage bodies are parsed by default."],
    evidence: [
      {
        kind: "official-doc",
        label: "OpenAI API rate-limit response headers",
        url: "https://platform.openai.com/docs/api-reference/debugging-requests",
        isOfficial: true,
        observedAt
      }
    ]
  },
  "anthropic-compatible": {
    providerId: "anthropic-compatible",
    domain: "",
    domainStatus: "unverified",
    protocols: ["anthropic"],
    inferenceEndpoints: [],
    quotaEndpointVerified: false,
    dashboardAvailable: false,
    automationAllowed: "unknown",
    notes: ["User-configured provider. Only explicit response headers and usage bodies are parsed by default."],
    evidence: [
      {
        kind: "official-doc",
        label: "Anthropic API rate-limit response headers",
        url: "https://platform.claude.com/docs/en/api/rate-limits",
        isOfficial: true,
        observedAt
      }
    ]
  }
};

export const bundledProviderConfigs: ThirdPartyProviderConfig[] = [
  {
    id: "nxtcodex",
    adapterId: "nxtcodex",
    displayName: "NXTCODEX",
    baseUrl: "https://nxtcodex.com/v1",
    apiKeyEnv: "NXTCODEX_API_KEY",
    protocol: "openai",
    enabled: true,
    refreshIntervalMinutes: 1,
    endpointVerified: false
  },
  {
    id: "antigravity",
    adapterId: "antigravity",
    displayName: "Antigravity",
    baseUrl: "https://api.antigravity.dev/v1",
    apiKeyEnv: "ANTIGRAVITY_API_KEY",
    protocol: "openai",
    enabled: true,
    refreshIntervalMinutes: 1,
    endpointVerified: false
  },
  {
    id: "freemodel",
    adapterId: "freemodel",
    displayName: "FreeModel",
    baseUrl: "https://api.freemodel.dev/v1",
    protocol: "openai",
    enabled: true,
    refreshIntervalMinutes: 15,
    endpointVerified: false
  },
  {
    id: "nttcodex",
    adapterId: "nttcodex",
    displayName: "NTTCodex",
    baseUrl: "https://nttcodex.com/v1",
    protocol: "unknown",
    enabled: true,
    refreshIntervalMinutes: 15,
    endpointVerified: false
  },
  {
    id: "openai-compatible",
    adapterId: "openai-compatible",
    displayName: "OpenAI-compatible",
    protocol: "openai",
    enabled: false,
    refreshIntervalMinutes: 15,
    endpointVerified: false
  },
  {
    id: "anthropic-compatible",
    adapterId: "anthropic-compatible",
    displayName: "Anthropic-compatible",
    protocol: "anthropic",
    enabled: false,
    refreshIntervalMinutes: 15,
    endpointVerified: false
  }
];

const displayNames: Record<ThirdPartyProviderId, string> = {
  nxtcodex: "NXTCODEX",
  antigravity: "Antigravity",
  freemodel: "FreeModel",
  nttcodex: "NTTCodex",
  "openai-compatible": "OpenAI-compatible",
  "anthropic-compatible": "Anthropic-compatible"
};

function headerMap(input: Headers | Record<string, string | undefined>): Map<string, string> {
  const result = new Map<string, string>();
  if (input instanceof Headers) {
    input.forEach((value, key) => result.set(key.toLowerCase(), value));
  } else {
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) result.set(key.toLowerCase(), value);
    }
  }
  return result;
}

function finiteNonnegative(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseResetAt(value: string | undefined, now = new Date()): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric >= 1e12 ? numeric : numeric >= 1e9 ? numeric * 1000 : now.getTime() + numeric * 1000;
    return new Date(milliseconds).toISOString();
  }
  if (/^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/i.test(trimmed)) {
    let ms = 0;
    for (const match of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/gi)) {
      const amount = Number(match[1]);
      const unit = match[2].toLowerCase();
      ms += amount * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1);
    }
    return new Date(now.getTime() + ms).toISOString();
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function makeSnapshot(
  providerId: ThirdPartyProviderId,
  protocol: "openai" | "anthropic" | "unknown",
  date: Date,
  patch: Partial<ProviderQuotaSnapshot>
): ProviderQuotaSnapshot {
  return {
    providerId,
    displayName: displayNames[providerId],
    status: "unavailable",
    confidence: "none",
    partial: true,
    fetchedAt: date.toISOString(),
    protocol,
    metrics: [],
    sources: [],
    warnings: [],
    ...patch
  };
}

function rateMetric(
  map: Map<string, string>,
  kind: QuotaMetric["kind"],
  label: string,
  prefix: string,
  now: Date
): QuotaMetric | undefined {
  const limit = finiteNonnegative(map.get(`${prefix}-limit`));
  const remaining = finiteNonnegative(map.get(`${prefix}-remaining`));
  const resetsAt = parseResetAt(map.get(`${prefix}-reset`), now);
  if (limit === undefined && remaining === undefined && resetsAt === undefined) return undefined;
  const used = limit !== undefined && remaining !== undefined ? Math.max(0, limit - Math.min(limit, remaining)) : undefined;
  return { kind, label, limit, remaining, used, resetsAt, unit: kind === "requests" ? "requests" : "tokens" };
}

function openAiRateMetric(
  map: Map<string, string>,
  kind: QuotaMetric["kind"],
  label: string,
  scope: "requests" | "tokens",
  now: Date
): QuotaMetric | undefined {
  const limit = finiteNonnegative(map.get(`x-ratelimit-limit-${scope}`));
  const remaining = finiteNonnegative(map.get(`x-ratelimit-remaining-${scope}`));
  const resetsAt = parseResetAt(map.get(`x-ratelimit-reset-${scope}`), now);
  if (limit === undefined && remaining === undefined && resetsAt === undefined) return undefined;
  const used = limit !== undefined && remaining !== undefined ? Math.max(0, limit - Math.min(limit, remaining)) : undefined;
  return { kind, label, limit, remaining, used, resetsAt, unit: scope };
}

function retryAfterAt(map: Map<string, string>, now: Date): string | undefined {
  const retryAfter = map.get("retry-after");
  if (!retryAfter) return undefined;
  return parseResetAt(retryAfter, now);
}

export function parseQuotaHeaders(
  providerId: ThirdPartyProviderId,
  protocol: "openai" | "anthropic" | "unknown",
  input: Headers | Record<string, string | undefined>,
  date = new Date()
): ProviderQuotaSnapshot {
  const map = headerMap(input);
  const metrics: QuotaMetric[] = [];
  if (protocol === "openai" || protocol === "unknown") {
    for (const metric of [
      openAiRateMetric(map, "requests", "Requests", "requests", date),
      openAiRateMetric(map, "tokens", "Tokens", "tokens", date)
    ]) if (metric) metrics.push(metric);
  }
  if (protocol === "anthropic" || protocol === "unknown") {
    for (const metric of [
      rateMetric(map, "requests", "Requests", "anthropic-ratelimit-requests", date),
      rateMetric(map, "tokens", "Most restrictive tokens", "anthropic-ratelimit-tokens", date),
      rateMetric(map, "input-tokens", "Input tokens", "anthropic-ratelimit-input-tokens", date),
      rateMetric(map, "output-tokens", "Output tokens", "anthropic-ratelimit-output-tokens", date)
    ]) if (metric) metrics.push(metric);
  }
  return makeSnapshot(providerId, protocol, date, {
    status: metrics.length ? "available" : "unavailable",
    confidence: metrics.length ? "high" : "none",
    partial: metrics.length === 0,
    metrics,
    retryAfterAt: retryAfterAt(map, date),
    sources: metrics.length ? [{
      kind: "official-header",
      label: `${protocol === "unknown" ? "Compatible API" : protocol} response rate-limit headers`,
      isOfficial: true,
      observedAt: date.toISOString()
    }] : [],
    error: metrics.length ? undefined : "No recognized rate-limit headers were present.",
    warnings: metrics.length ? ["Rate-limit headroom is not the same as account credit or subscription quota."] : []
  });
}

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;

function parseJsonOrStream(body: unknown): JsonRecord[] {
  if (typeof body !== "string") return record(body) ? [body as JsonRecord] : [];
  const trimmed = body.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      return record(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  }
  const events: JsonRecord[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (!payload || payload === "[DONE]" || !payload.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(payload);
      if (record(parsed)) events.push(parsed);
    } catch {
      // Ignore malformed or partial streaming frames.
    }
  }
  return events;
}

function usageFromOpenAi(events: JsonRecord[]): QuotaMetric | undefined {
  let usage: JsonRecord | undefined;
  for (const event of events) {
    const candidate = record(event.usage) ?? record(record(event.response)?.usage);
    if (candidate) usage = candidate;
  }
  if (!usage) return undefined;
  const input = finiteNonnegative(usage.input_tokens ?? usage.prompt_tokens) ?? 0;
  const output = finiteNonnegative(usage.output_tokens ?? usage.completion_tokens) ?? 0;
  const providerTotal = finiteNonnegative(usage.total_tokens);
  const total = providerTotal ?? input + output;
  return { kind: "observed-usage", label: "Observed request usage", used: total, unit: "tokens" };
}

function usageFromAnthropic(events: JsonRecord[]): QuotaMetric | undefined {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let found = false;
  for (const event of events) {
    const usage = record(event.usage) ?? record(record(event.message)?.usage);
    if (!usage) continue;
    const nextInput = finiteNonnegative(usage.input_tokens);
    const nextOutput = finiteNonnegative(usage.output_tokens);
    const nextCacheRead = finiteNonnegative(usage.cache_read_input_tokens);
    const nextCacheWrite = finiteNonnegative(usage.cache_creation_input_tokens);
    if (nextInput !== undefined) input = Math.max(input, nextInput);
    if (nextOutput !== undefined) output = Math.max(output, nextOutput);
    if (nextCacheRead !== undefined) cacheRead = Math.max(cacheRead, nextCacheRead);
    if (nextCacheWrite !== undefined) cacheWrite = Math.max(cacheWrite, nextCacheWrite);
    found = true;
  }
  if (!found) return undefined;
  return {
    kind: "observed-usage",
    label: "Observed request usage",
    used: input + output + cacheRead + cacheWrite,
    unit: "tokens"
  };
}

export function parseUsageBody(
  providerId: ThirdPartyProviderId,
  protocol: "openai" | "anthropic" | "unknown",
  body: unknown,
  date = new Date()
): ProviderQuotaSnapshot {
  const events = parseJsonOrStream(body);
  const metric =
    protocol === "anthropic" ? usageFromAnthropic(events) :
    protocol === "openai" ? usageFromOpenAi(events) :
    usageFromOpenAi(events) ?? usageFromAnthropic(events);
  return makeSnapshot(providerId, protocol, date, {
    status: metric ? "partial" : "unavailable",
    confidence: metric ? "high" : "none",
    partial: true,
    metrics: metric ? [metric] : [],
    sources: metric ? [{
      kind: "local-observation",
      label: "Usage object from a provider response",
      isOfficial: false,
      observedAt: date.toISOString()
    }] : [],
    error: metric ? undefined : "No recognized OpenAI or Anthropic usage object was present.",
    warnings: metric ? ["Observed usage does not reveal remaining account credit or subscription quota."] : []
  });
}

function metricKind(value: unknown): QuotaMetric["kind"] | undefined {
  const normalized = String(value ?? "").toLowerCase().replaceAll("_", "-");
  if (normalized.includes("input") && normalized.includes("token")) return "input-tokens";
  if (normalized.includes("output") && normalized.includes("token")) return "output-tokens";
  if (normalized.includes("request")) return "requests";
  if (normalized.includes("token")) return "tokens";
  if (normalized.includes("credit")) return "credits";
  if (normalized.includes("currency") || normalized === "usd" || normalized === "vnd") return "currency";
  return undefined;
}

function explicitMetric(value: unknown, fallbackKind: QuotaMetric["kind"] | undefined, date: Date): QuotaMetric | undefined {
  const item = record(value);
  if (!item) return undefined;
  const kind = metricKind(item.kind ?? item.type ?? item.name ?? item.unit) ?? fallbackKind;
  if (!kind) return undefined;
  const limit = finiteNonnegative(item.limit ?? item.total ?? item.maximum);
  const remaining = finiteNonnegative(item.remaining ?? item.balance);
  const used = finiteNonnegative(item.used);
  if (limit === undefined && remaining === undefined && used === undefined) return undefined;
  const derivedUsed = used ?? (
    limit !== undefined && remaining !== undefined && remaining <= limit
      ? limit - remaining
      : undefined
  );
  const resetValue = item.reset_at ?? item.resets_at ?? item.reset ?? item.reset_seconds;
  const resetsAt = resetValue === undefined ? undefined : parseResetAt(String(resetValue), date);
  const defaultUnit = kind === "requests" ? "requests" : kind === "credits" ? "credits" : kind === "currency" ? String(item.currency ?? item.unit ?? "currency") : "tokens";
  return {
    kind,
    label: String(item.label ?? item.name ?? (
      kind === "requests" ? "Requests" :
      kind === "credits" ? "Credits" :
      kind === "currency" ? "Balance" :
      kind === "input-tokens" ? "Input tokens" :
      kind === "output-tokens" ? "Output tokens" : "Tokens"
    )).slice(0, 80),
    limit,
    remaining,
    used: derivedUsed,
    unit: String(item.currency ?? item.unit ?? defaultUnit).slice(0, 24),
    resetsAt
  };
}

export function parseExplicitQuotaBody(
  providerId: ThirdPartyProviderId,
  protocol: "openai" | "anthropic" | "unknown",
  body: unknown,
  date = new Date(),
  endpointVerified = false
): ProviderQuotaSnapshot {
  const events = parseJsonOrStream(body);
  const metrics: QuotaMetric[] = [];
  for (const event of events) {
    const containers = [event, record(event.data)].filter((item): item is JsonRecord => Boolean(item));
    for (const container of containers) {
      const arrays = [container.quotas, container.rate_limits, container.limits];
      for (const list of arrays) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          const metric = explicitMetric(item, undefined, date);
          if (metric) metrics.push(metric);
        }
      }
      const quota = explicitMetric(container.quota, undefined, date);
      const credits = explicitMetric(container.credits, "credits", date);
      const balance = explicitMetric(container.balance, "currency", date);
      if (quota) metrics.push(quota);
      if (credits) metrics.push(credits);
      if (balance) metrics.push(balance);
    }
  }
  const unique = metrics.filter((metric, index) =>
    metrics.findIndex((candidate) =>
      candidate.kind === metric.kind &&
      candidate.label === metric.label &&
      candidate.resetsAt === metric.resetsAt
    ) === index
  );
  const hasRemaining = unique.some((metric) => metric.remaining !== undefined);
  return makeSnapshot(providerId, protocol, date, {
    status: hasRemaining ? "available" : unique.length ? "partial" : "unavailable",
    confidence: unique.length ? endpointVerified ? "high" : "medium" : "none",
    partial: !hasRemaining,
    metrics: unique,
    sources: unique.length ? [{
      kind: endpointVerified ? "official-api" : "configured-endpoint",
      label: endpointVerified ? "Verified provider quota API response" : "User-configured quota endpoint response",
      isOfficial: endpointVerified,
      observedAt: date.toISOString()
    }] : [],
    error: unique.length ? undefined : "No explicit quota, credit, or rate-limit object was present.",
    warnings: endpointVerified || !unique.length ? [] : ["The endpoint was user-configured and has not been verified as an official provider API."]
  });
}

function unavailableSnapshot(
  config: ThirdPartyProviderConfig,
  date: Date,
  status: ProviderQuotaSnapshot["status"],
  error: string
): ProviderQuotaSnapshot {
  const research = providerResearch[config.id];
  let displayEndpoint: string | undefined;
  if (config.quotaEndpoint) {
    try {
      const url = new URL(config.quotaEndpoint);
      if (url.protocol === "https:" && !url.username && !url.password) {
        displayEndpoint = `${url.origin}${url.pathname}`;
      }
    } catch {
      // Invalid configured URLs are never copied into a persisted snapshot.
    }
  }
  return makeSnapshot(config.id, config.protocol, date, {
    displayName: config.displayName,
    status,
    endpoint: displayEndpoint,
    sources: research.evidence,
    error,
    warnings: research.notes
  });
}

function safeQuotaEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Quota endpoint must use HTTPS.");
  if (url.username || url.password || url.search) throw new Error("Quota endpoint must not contain credentials or query parameters.");
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) throw new Error("Quota endpoint must not target a private or loopback address.");
  if (isIP(host) && !isPublicIp(host)) throw new Error("Quota endpoint must resolve to a public address.");
  return url;
}

function isPublicIp(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : undefined);
  if (!ipv4) return true;
  const parts = ipv4.split(".").map(Number);
  return !(
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] >= 224
  );
}

async function assertPublicResolution(hostname: string): Promise<void> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => !isPublicIp(item.address))) {
    throw new Error("Quota endpoint DNS resolution includes a private or reserved address.");
  }
}

async function readLimitedBody(response: Response, maximumBytes = 1_000_000): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error("Quota response exceeds the 1 MB safety limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error("Quota response exceeds the 1 MB safety limit.");
    }
    result += decoder.decode(chunk.value, { stream: true });
  }
  return result + decoder.decode();
}

function mergeSnapshots(
  config: ThirdPartyProviderConfig,
  headers: ProviderQuotaSnapshot,
  body: ProviderQuotaSnapshot,
  httpStatus: number,
  endpoint: string
): ProviderQuotaSnapshot {
  const metrics = [...headers.metrics, ...body.metrics];
  const rateMetrics = headers.metrics.length > 0;
  const hasRemaining = metrics.some((metric) => metric.remaining !== undefined);
  return {
    ...headers,
    displayName: config.displayName,
    status: rateMetrics || hasRemaining ? "available" : body.metrics.length ? "partial" : "unavailable",
    confidence: rateMetrics ? "high" : body.confidence,
    partial: !rateMetrics && !hasRemaining,
    endpoint,
    metrics,
    sources: [...headers.sources, ...body.sources],
    httpStatus,
    retryAfterAt: headers.retryAfterAt,
    error: metrics.length ? undefined : body.error,
    warnings: [...new Set([...headers.warnings, ...body.warnings])]
  };
}

export class CompatibleQuotaAdapter implements QuotaProviderAdapter {
  readonly id: ThirdPartyProviderId;
  private lastError?: string;

  constructor(readonly config: ThirdPartyProviderConfig) {
    this.id = config.id;
  }

  async detect(): Promise<ProviderDetectionResult> {
    const research = providerResearch[this.id];
    return {
      providerId: this.id,
      domainStatus: research.domainStatus,
      reachable: "not-checked",
      publicBaseUrl: this.config.baseUrl ?? research.publicBaseUrl,
      notes: research.notes,
      evidence: research.evidence
    };
  }

  capabilities(): ProviderCapabilities {
    const research = providerResearch[this.id];
    return {
      providerId: this.id,
      protocols: research.protocols,
      inferenceEndpoints: research.inferenceEndpoints,
      quotaEndpointVerified: Boolean(this.config.endpointVerified && this.config.quotaEndpoint),
      canParseHeaders: true,
      canParseBodies: true,
      canFetchDirectly: Boolean(this.config.quotaEndpoint)
    };
  }

  parseResponseHeaders(
    headers: Headers | Record<string, string | undefined>,
    date = new Date()
  ): ProviderQuotaSnapshot {
    return parseQuotaHeaders(this.id, this.config.protocol, headers, date);
  }

  parseResponseBody(body: unknown, date = new Date()): ProviderQuotaSnapshot {
    const quota = parseExplicitQuotaBody(
      this.id,
      this.config.protocol,
      body,
      date,
      this.config.endpointVerified
    );
    if (quota.metrics.length) return quota;
    return parseUsageBody(this.id, this.config.protocol, body, date);
  }

  async fetchQuota(context: QuotaFetchContext): Promise<ProviderQuotaSnapshot> {
    const date = context.now ?? new Date();
    if (!this.config.enabled) return unavailableSnapshot(this.config, date, "unavailable", "Provider is disabled.");
    if (!this.config.quotaEndpoint) {
      return unavailableSnapshot(
        this.config,
        date,
        providerResearch[this.id].domainStatus === "verified" ? "unavailable" : "unverified",
        "No official quota or balance endpoint has been verified; no request was sent."
      );
    }
    if (!context.allowNetwork) {
      return unavailableSnapshot(this.config, date, "unavailable", "Network access is disabled; no request was sent.");
    }

    let endpoint: URL;
    try {
      endpoint = safeQuotaEndpoint(this.config.quotaEndpoint);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Invalid quota endpoint.";
      return unavailableSnapshot(this.config, date, "error", this.lastError);
    }
    const key = this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv] : undefined;
    if (this.config.apiKeyEnv && !key) {
      return unavailableSnapshot(
        this.config,
        date,
        "unavailable",
        `Environment variable ${this.config.apiKeyEnv} is not set; no request was sent.`
      );
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (key) {
      if (this.config.protocol === "anthropic") {
        headers["x-api-key"] = key;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers.authorization = `Bearer ${key}`;
      }
    }
    try {
      if (!context.fetcher) await assertPublicResolution(endpoint.hostname);
      const response = await (context.fetcher ?? fetch)(endpoint, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(10_000)
      });
      const headerSnapshot = this.parseResponseHeaders(response.headers, date);
      if (response.status === 401 || response.status === 403) {
        return {
          ...headerSnapshot,
          displayName: this.config.displayName,
          status: "error",
          partial: true,
          endpoint: endpoint.toString(),
          httpStatus: response.status,
          error: "Authentication or authorization failed. Automatic retries are stopped."
        };
      }
      if (response.status === 429) {
        return {
          ...headerSnapshot,
          displayName: this.config.displayName,
          status: headerSnapshot.metrics.length ? "partial" : "error",
          partial: true,
          endpoint: endpoint.toString(),
          httpStatus: 429,
          error: "Provider rate limit reached. Refresh is paused until Retry-After when available."
        };
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("json")) {
        return {
          ...headerSnapshot,
          displayName: this.config.displayName,
          status: headerSnapshot.metrics.length ? "partial" : "error",
          partial: true,
          endpoint: endpoint.toString(),
          httpStatus: response.status,
          error: "Quota endpoint returned a non-JSON response; body was discarded."
        };
      }
      const text = await readLimitedBody(response);
      const bodySnapshot = this.parseResponseBody(text, date);
      if (!response.ok) {
        return {
          ...headerSnapshot,
          displayName: this.config.displayName,
          status: headerSnapshot.metrics.length ? "partial" : "error",
          partial: true,
          endpoint: endpoint.toString(),
          httpStatus: response.status,
          error: `Quota endpoint returned HTTP ${response.status}.`
        };
      }
      return mergeSnapshots(this.config, headerSnapshot, bodySnapshot, response.status, endpoint.toString());
    } catch (error) {
      this.lastError = error instanceof Error ? error.message.replace(key ?? "\0", "[REDACTED]") : "Quota request failed.";
      return unavailableSnapshot(this.config, date, "error", this.lastError);
    }
  }

  diagnostics(): ProviderQuotaDiagnostics {
    return {
      providerId: this.id,
      networkDefault: "disabled",
      credentialSource: "environment-only",
      quotaEndpoint: this.config.endpointVerified && this.config.quotaEndpoint
        ? "verified"
        : this.config.quotaEndpoint ? "configured-unverified" : "unavailable",
      lastError: this.lastError,
      warnings: providerResearch[this.id].notes
    };
  }
}

export function createQuotaAdapter(config: ThirdPartyProviderConfig): QuotaProviderAdapter {
  return new CompatibleQuotaAdapter(config);
}
