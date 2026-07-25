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
