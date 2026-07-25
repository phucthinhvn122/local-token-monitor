import { z } from "zod";

export const ProviderSchema = z.enum(["codex", "claude"]);
export const AccuracySchema = z.enum(["exact", "derived", "estimated", "unavailable"]);
export const SourceSchema = z.enum(["official", "session", "log", "estimated"]);

export const TokenUsageEventSchema = z.object({
  id: z.string().min(1),
  fingerprint: z.string().min(1),
  provider: ProviderSchema,
  source: SourceSchema,
  accuracy: AccuracySchema,
  sessionId: z.string().optional(),
  projectId: z.string().optional(),
  projectPath: z.string().optional(),
  model: z.string().optional(),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  reasoningTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative(),
  estimatedCost: z.number().nonnegative().optional(),
  currency: z.literal("USD").optional(),
  estimationMethod: z.string().optional(),
  timestamp: z.string().datetime(),
  isDemo: z.boolean().default(false)
});

export type Provider = z.infer<typeof ProviderSchema>;
export type Accuracy = z.infer<typeof AccuracySchema>;
export type UsageSource = z.infer<typeof SourceSchema>;
export type TokenUsageEvent = z.infer<typeof TokenUsageEventSchema>;

export interface ProjectInfo {
  id: string;
  name: string;
  displayName?: string;
  path: string;
  gitRemote?: string;
  gitBranch?: string;
  repositoryName?: string;
  hidden?: boolean;
  isDemo?: boolean;
}

export interface DetectedSession {
  id: string;
  provider: Provider;
  projectPath?: string;
  projectId?: string;
  model?: string;
  processId?: number;
  startedAt: string;
  lastActivityAt: string;
  status: "running" | "completed";
  isDemo?: boolean;
}

export interface InstallationInfo {
  installed: boolean;
  version?: string;
  executablePath?: string;
  warning?: string;
}

export interface CollectorSource {
  id: string;
  provider: Provider;
  path: string;
  kind: "json" | "jsonl" | "log";
  parserVersion: string;
  exists: boolean;
}

export interface UsageLimitWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string;
}

export interface ProviderUsageLimits {
  primary?: UsageLimitWindow;
  secondary?: UsageLimitWindow;
  updatedAt: string;
}

export interface AdapterDiagnostics {
  provider: Provider;
  installation: InstallationInfo;
  candidatePaths: Array<{ path: string; exists: boolean }>;
  running: boolean;
  watchedFiles: number;
  collectedEvents: number;
  duplicateEvents: number;
  usageLimits?: ProviderUsageLimits;
  lastParseError?: string;
  warning?: string;
}

export interface ProviderAdapter {
  id: Provider;
  detectInstallation(): Promise<InstallationInfo>;
  discoverSources(): Promise<CollectorSource[]>;
  detectRunningSessions(): Promise<DetectedSession[]>;
  parseSource(source: CollectorSource): AsyncIterable<TokenUsageEvent>;
  getDiagnostics(): Promise<AdapterDiagnostics>;
}

export interface ModelPricing {
  provider: "openai" | "anthropic";
  modelPattern: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  effectiveFrom: string;
  sourceUrl?: string;
}

export interface AppSettings {
  port: number;
  databasePath: string;
  retentionDays: number;
  pollingIntervalMs: number;
  codexCollectorEnabled: boolean;
  claudeCollectorEnabled: boolean;
  tokenEstimationEnabled: boolean;
  costEstimationEnabled: boolean;
  privacyMode: boolean;
  demoMode: boolean;
  allowNetwork: boolean;
  providerNetworkEnabled: boolean;
  customProviderPaths: string[];
  customLogPaths: string[];
}

export interface ProcessInfo {
  pid: number;
  parentPid?: number;
  name: string;
  executablePath?: string;
  command?: string;
  cwd?: string;
  startedAt?: string;
  provider: Provider;
}

export interface UsageFilters {
  from?: string;
  to?: string;
  provider?: Provider;
  projectId?: string;
  sessionId?: string;
  model?: string;
  accuracy?: Accuracy;
  interval?: string;
}

export const ThirdPartyProviderIdSchema = z.enum([
  "freemodel",
  "nttcodex",
  "openai-compatible",
  "anthropic-compatible"
]);
export const QuotaConfidenceSchema = z.enum(["high", "medium", "low", "none"]);
export const QuotaStatusSchema = z.enum(["available", "partial", "unavailable", "unverified", "error"]);
export const QuotaMetricKindSchema = z.enum([
  "requests",
  "tokens",
  "input-tokens",
  "output-tokens",
  "credits",
  "currency",
  "context-tokens",
  "observed-usage"
]);
export const QuotaSourceKindSchema = z.enum([
  "official-doc",
  "official-header",
  "official-api",
  "provider-dashboard",
  "configured-endpoint",
  "local-observation"
]);

export const QuotaMetricSchema = z.object({
  kind: QuotaMetricKindSchema,
  label: z.string().min(1),
  limit: z.number().nonnegative().optional(),
  used: z.number().nonnegative().optional(),
  remaining: z.number().nonnegative().optional(),
  unit: z.string().min(1),
  window: z.string().optional(),
  resetsAt: z.string().datetime().optional(),
  model: z.string().optional()
});

export const QuotaEvidenceSchema = z.object({
  kind: QuotaSourceKindSchema,
  label: z.string().min(1),
  url: z.string().url().optional(),
  isOfficial: z.boolean(),
  observedAt: z.string().datetime()
});

export const ProviderQuotaSnapshotSchema = z.object({
  providerId: ThirdPartyProviderIdSchema,
  displayName: z.string().min(1),
  status: QuotaStatusSchema,
  confidence: QuotaConfidenceSchema,
  partial: z.boolean(),
  fetchedAt: z.string().datetime(),
  endpoint: z.string().url().optional(),
  protocol: z.enum(["openai", "anthropic", "unknown"]),
  metrics: z.array(QuotaMetricSchema),
  sources: z.array(QuotaEvidenceSchema),
  httpStatus: z.number().int().min(100).max(599).optional(),
  retryAfterAt: z.string().datetime().optional(),
  error: z.string().optional(),
  warnings: z.array(z.string()).default([])
});

const ProviderUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    host !== "localhost" &&
    host !== "::1" &&
    !host.endsWith(".local") &&
    !/^127\./.test(host) &&
    !/^10\./.test(host) &&
    !/^192\.168\./.test(host) &&
    !/^169\.254\./.test(host) &&
    !/^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}, "Provider URL must be public HTTPS and contain no credentials or query parameters");

export const ThirdPartyProviderConfigSchema = z.object({
  id: ThirdPartyProviderIdSchema,
  adapterId: z.enum(["freemodel", "nttcodex", "openai-compatible", "anthropic-compatible"]),
  displayName: z.string().trim().min(1).max(80),
  baseUrl: ProviderUrlSchema.optional(),
  quotaEndpoint: ProviderUrlSchema.optional(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  protocol: z.enum(["openai", "anthropic", "unknown"]),
  enabled: z.boolean(),
  refreshIntervalMinutes: z.number().int().min(1).max(1440),
  endpointVerified: z.boolean().default(false)
});

export type ThirdPartyProviderId = z.infer<typeof ThirdPartyProviderIdSchema>;
export type QuotaConfidence = z.infer<typeof QuotaConfidenceSchema>;
export type QuotaStatus = z.infer<typeof QuotaStatusSchema>;
export type QuotaMetricKind = z.infer<typeof QuotaMetricKindSchema>;
export type QuotaSourceKind = z.infer<typeof QuotaSourceKindSchema>;
export type QuotaMetric = z.infer<typeof QuotaMetricSchema>;
export type QuotaEvidence = z.infer<typeof QuotaEvidenceSchema>;
export type ProviderQuotaSnapshot = z.infer<typeof ProviderQuotaSnapshotSchema>;
export type ThirdPartyProviderConfig = z.infer<typeof ThirdPartyProviderConfigSchema>;

export interface ProviderDetectionResult {
  providerId: ThirdPartyProviderId;
  domainStatus: "verified" | "unverified";
  reachable: boolean | "not-checked";
  publicBaseUrl?: string;
  notes: string[];
  evidence: QuotaEvidence[];
}

export interface ProviderCapabilities {
  providerId: ThirdPartyProviderId;
  protocols: Array<"openai" | "anthropic">;
  inferenceEndpoints: string[];
  quotaEndpointVerified: boolean;
  canParseHeaders: boolean;
  canParseBodies: boolean;
  canFetchDirectly: boolean;
}

export interface ProviderQuotaDiagnostics {
  providerId: ThirdPartyProviderId;
  networkDefault: "disabled";
  credentialSource: "environment-only";
  quotaEndpoint: "verified" | "configured-unverified" | "unavailable";
  lastError?: string;
  warnings: string[];
}

export interface QuotaFetchContext {
  allowNetwork: boolean;
  now?: Date;
  fetcher?: typeof fetch;
}

export interface QuotaProviderAdapter {
  readonly id: ThirdPartyProviderId;
  detect(): Promise<ProviderDetectionResult>;
  capabilities(): ProviderCapabilities;
  fetchQuota(context: QuotaFetchContext): Promise<ProviderQuotaSnapshot>;
  parseResponseHeaders(headers: Headers | Record<string, string | undefined>, observedAt?: Date): ProviderQuotaSnapshot;
  parseResponseBody(body: unknown, observedAt?: Date): ProviderQuotaSnapshot;
  diagnostics(): ProviderQuotaDiagnostics;
}
