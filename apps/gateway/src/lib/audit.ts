import { Prisma, prisma } from "@cgw/db";
import { redactSecrets } from "@cgw/core";

export type AuditAction =
  | "user.create"
  | "user.update"
  | "user.delete"
  | "apikey.create"
  | "apikey.topup"
  | "apikey.update"
  | "apikey.revoke"
  | "apikey.delete"
  | "provider.create"
  | "provider.update"
  | "provider.delete"
  | "provider.test"
  | "provider.circuit_open"
  | "settings.update"
  | "auth.login"
  | "auth.logout"
  | "auth.password_change"
  | "auth.totp_enable"
  | "auth.totp_disable";

/**
 * Audit writes must never break the operation they describe, so failures are
 * swallowed after being logged. Metadata is redacted because callers pass
 * request payloads straight through.
 */
export async function recordAudit(input: {
  adminId: string | null;
  action: AuditAction;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}): Promise<void> {
  try {
    const metadata = input.metadata
      ? (JSON.parse(redactSecrets(JSON.stringify(input.metadata))) as Prisma.InputJsonValue)
      : Prisma.JsonNull;
    await prisma.adminAuditLog.create({
      data: {
        adminId: input.adminId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        metadata,
        ip: input.ip ?? null
      }
    });
  } catch (error) {
    console.warn("[audit] failed to record entry", { action: input.action, error: String(error) });
  }
}

/** Fields that must be stripped before an object is written to an audit row. */
export function scrubAuditPayload<T extends Record<string, unknown>>(payload: T): Partial<T> {
  const { apiKey, password, ...rest } = payload as Record<string, unknown>;
  void apiKey;
  void password;
  return rest as Partial<T>;
}
