import { z } from "zod";

/**
 * Fail fast and loudly on misconfiguration. A gateway that boots with a weak
 * or missing encryption key would silently write unrecoverable provider
 * credentials, so both secrets are required and length-checked.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1),

  /** 32-byte key, hex (64 chars) or base64. Encrypts pool provider API keys. */
  ENCRYPTION_KEY: z.string().min(32),
  /** HMAC secret for dashboard session cookies. */
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 7),
  COOKIE_SECURE: z
    .enum(["true", "false", "auto"])
    .default("auto")
    .transform((value) => value),

  /** Public origin of the gateway, embedded in generated Codex configs. */
  PUBLIC_GATEWAY_URL: z.string().url().default("http://localhost:4000"),
  /** Origin allowed to send credentialed browser requests (the web app). */
  WEB_ORIGIN: z.string().default("http://localhost:3000"),

  /**
   * When true, user API keys are stored as a hash only. The Codex auto-setup
   * page can then only generate a working config during the session in which
   * the key was issued; after a gateway restart the admin must issue a new key.
   */
  STRICT_ONE_TIME_KEYS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  /** Bootstrap admin, created on first boot when no admin exists. */
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(10).optional(),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** Background job cadence. */
  HEALTH_CHECK_INTERVAL_MS: z.coerce.number().int().min(10_000).default(300_000),
  RETENTION_SWEEP_INTERVAL_MS: z.coerce.number().int().min(60_000).default(6 * 3_600_000),
  ENABLE_BACKGROUND_JOBS: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true")
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join("\n")}`);
  }
  return parsed.data;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

export function isCookieSecure(config: Env): boolean {
  if (config.COOKIE_SECURE === "true") return true;
  if (config.COOKIE_SECURE === "false") return false;
  return config.PUBLIC_GATEWAY_URL.startsWith("https://");
}
