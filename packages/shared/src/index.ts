import { z } from "zod";

export * from "./codex-config.js";

/* ------------------------------------------------------------------ enums */

export const RoleSchema = z.enum(["ADMIN", "USER"]);
export const UserStatusSchema = z.enum(["ACTIVE", "SUSPENDED"]);
export const ApiKeyStatusSchema = z.enum(["ACTIVE", "REVOKED"]);
export const WireApiSchema = z.enum(["CHAT", "RESPONSES"]);
export const RoutingStrategySchema = z.enum(["PRIORITY", "ROUND_ROBIN", "WEIGHTED"]);
export const TransactionTypeSchema = z.enum(["GRANT", "TOPUP", "DEDUCT", "ADJUST"]);

export type Role = z.infer<typeof RoleSchema>;
export type UserStatus = z.infer<typeof UserStatusSchema>;
export type ApiKeyStatus = z.infer<typeof ApiKeyStatusSchema>;
export type WireApi = z.infer<typeof WireApiSchema>;
export type RoutingStrategy = z.infer<typeof RoutingStrategySchema>;
export type TransactionType = z.infer<typeof TransactionTypeSchema>;

/* ------------------------------------------------------------------- auth */

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
  /** Required on the second round when the account has TOTP enabled. */
  totpCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code")
    .optional()
});

export const TotpEnableSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code")
});

export const TotpDisableSchema = z.object({
  password: z.string().min(1).max(200),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code")
});

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10, "Use at least 10 characters").max(200)
});

/* ------------------------------------------------------------ admin: users */

export const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().max(120).optional(),
  password: z.string().min(10, "Use at least 10 characters").max(200),
  role: RoleSchema.default("USER")
});

export const UpdateUserSchema = z
  .object({
    name: z.string().trim().max(120).nullable().optional(),
    role: RoleSchema.optional(),
    status: UserStatusSchema.optional(),
    password: z.string().min(10).max(200).optional()
  })
  .strict();

export const UserListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: UserStatusSchema.optional(),
  role: RoleSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
});

/* --------------------------------------------------------- admin: api keys */

/** Guard against absurd values while still allowing very large grants. */
const TOKEN_AMOUNT_MAX = 1_000_000_000_000;

export const CreateApiKeySchema = z
  .object({
    userId: z.string().uuid().optional(),
    /** Provide either an existing userId, or these fields to create the user. */
    newUser: CreateUserSchema.optional(),
    name: z.string().trim().min(1).max(80).default("Default key"),
    tokenQuota: z.coerce.number().int().min(0).max(TOKEN_AMOUNT_MAX),
    expiresAt: z.string().datetime().nullable().optional(),
    rateLimitPerMin: z.coerce.number().int().min(0).max(100_000).default(0),
    maxConcurrent: z.coerce.number().int().min(0).max(1000).default(0),
    note: z.string().trim().max(500).optional()
  })
  .refine((value) => Boolean(value.userId) !== Boolean(value.newUser), {
    message: "Provide exactly one of userId or newUser"
  });

export const TopUpSchema = z.object({
  amount: z.coerce.number().int().min(1).max(TOKEN_AMOUNT_MAX),
  note: z.string().trim().max(500).optional()
});

export const UpdateApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    status: ApiKeyStatusSchema.optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    rateLimitPerMin: z.coerce.number().int().min(0).max(100_000).optional(),
    maxConcurrent: z.coerce.number().int().min(0).max(1000).optional()
  })
  .strict();

/* -------------------------------------------------------- admin: providers */

/**
 * Pool provider URLs are operator-supplied and may legitimately point at a
 * private address (another container on the same Docker network). Only the
 * scheme is constrained; SSRF is out of scope because only admins can write
 * here and the target is by definition an upstream the operator controls.
 */
const ProviderUrlSchema = z
  .string()
  .url()
  .max(500)
  .refine((value) => /^https?:$/.test(new URL(value).protocol), {
    message: "Base URL must use http or https"
  });

export const CreateProviderSchema = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: ProviderUrlSchema,
  apiKey: z.string().trim().min(1).max(500),
  wireApi: WireApiSchema.default("CHAT"),
  priority: z.coerce.number().int().min(0).max(10_000).default(100),
  weight: z.coerce.number().int().min(1).max(1000).default(1),
  models: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  isActive: z.boolean().default(true),
  timeoutMs: z.coerce.number().int().min(1000).max(3_600_000).default(600_000)
});

export const UpdateProviderSchema = CreateProviderSchema.partial()
  .extend({ apiKey: z.string().trim().min(1).max(500).optional() })
  .strict();

export const TestProviderSchema = z
  .object({
    /** Test an unsaved form: supply credentials inline. */
    baseUrl: ProviderUrlSchema.optional(),
    apiKey: z.string().trim().min(1).max(500).optional(),
    wireApi: WireApiSchema.optional(),
    model: z.string().trim().max(120).optional()
  })
  .strict();

/* -------------------------------------------------------------- admin: ops */

export const SystemSettingsSchema = z
  .object({
    routingStrategy: RoutingStrategySchema.optional(),
    circuitThreshold: z.coerce.number().int().min(1).max(100).optional(),
    circuitCooldownSeconds: z.coerce.number().int().min(5).max(86_400).optional(),
    logRetentionDays: z.coerce.number().int().min(1).max(3650).optional(),
    defaultRateLimitPerMin: z.coerce.number().int().min(1).max(100_000).optional(),
    defaultMaxConcurrent: z.coerce.number().int().min(1).max(1000).optional(),
    quotaWarnPercent: z.coerce.number().int().min(1).max(90).optional(),
    gatewayPublicUrl: z.string().url().max(500).nullable().optional(),
    defaultModel: z.string().trim().min(1).max(120).optional()
  })
  .strict();

export const LogQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  apiKeyId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  providerId: z.string().uuid().optional(),
  model: z.string().trim().max(120).optional(),
  status: z.enum(["success", "error"]).optional(),
  sessionId: z.string().trim().max(200).optional(),
  sort: z.enum(["createdAt", "totalTokens", "latencyMs"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50)
});

export type LogSortKey = z.infer<typeof LogQuerySchema>["sort"];

export const StatsQuerySchema = z.object({
  range: z.enum(["24h", "7d", "30d", "90d"]).default("30d"),
  bucket: z.enum(["hour", "day", "week"]).optional()
});

/* ---------------------------------------------------------- codex setup UI */

export const CodexSetupQuerySchema = z.object({
  mode: z.enum(["provider", "openai"]).default("provider"),
  apiKeyId: z.string().uuid().optional(),
  model: z.string().trim().max(120).optional()
});

/* ------------------------------------------------------------- view models */

export interface ApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  maskedKey: string;
  tokenQuota: number;
  tokenUsed: number;
  tokenRemaining: number;
  usedPercent: number;
  status: ApiKeyStatus;
  rateLimitPerMin: number;
  maxConcurrent: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  user?: { id: string; email: string; name: string | null; status: UserStatus };
}

export interface ProviderView {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  wireApi: WireApi;
  priority: number;
  weight: number;
  models: string[];
  isActive: boolean;
  timeoutMs: number;
  lastHealthCheck: string | null;
  lastHealthOk: boolean | null;
  lastHealthLatency: number | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  consecutiveErrors: number;
  circuitOpenUntil: string | null;
  /** Derived: circuitOpenUntil is in the future. */
  circuitOpen: boolean;
  stats?: { requests: number; errors: number; errorRate: number; totalTokens: number; avgLatencyMs: number };
}

export interface UsageLogView {
  id: string;
  createdAt: string;
  model: string | null;
  endpoint: string;
  sessionId: string | null;
  streamed: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  accuracy: string;
  latencyMs: number;
  statusCode: number;
  errorMessage: string | null;
  providerName?: string | null;
  userEmail?: string | null;
  keyPrefix?: string | null;
}

export interface TimeseriesPoint {
  bucket: string;
  requests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  errors: number;
}

export interface QuotaSummary {
  tokenQuota: number;
  tokenUsed: number;
  tokenRemaining: number;
  usedPercent: number;
  level: "safe" | "warning" | "critical" | "depleted";
  /** Mean daily burn over the recent window, in tokens. */
  dailyBurnRate: number;
  /** Projection from the burn rate; null when there is not enough signal. */
  estimatedDaysRemaining: number | null;
}

/** Shared thresholds so admin and user views agree on colour semantics. */
export function quotaLevel(usedPercent: number, warnPercent = 10): QuotaSummary["level"] {
  const remaining = 100 - usedPercent;
  if (remaining <= 0) return "depleted";
  if (remaining <= warnPercent / 2) return "critical";
  if (remaining <= warnPercent) return "warning";
  return "safe";
}

export const GATEWAY_ERROR_CODES = {
  invalidApiKey: "invalid_api_key",
  keyRevoked: "api_key_revoked",
  keyExpired: "api_key_expired",
  userSuspended: "user_suspended",
  quotaExhausted: "insufficient_quota",
  rateLimited: "rate_limit_exceeded",
  tooManyConcurrent: "too_many_concurrent_requests",
  noProvider: "no_provider_available",
  upstreamError: "upstream_error"
} as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[keyof typeof GATEWAY_ERROR_CODES];
