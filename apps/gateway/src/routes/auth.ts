import type { FastifyInstance } from "fastify";
import { prisma } from "@cgw/db";
import { ChangePasswordSchema, LoginSchema, TotpDisableSchema, TotpEnableSchema } from "@cgw/shared";
import { hashPassword, verifyPassword } from "../lib/crypto.js";
import { HttpError, badRequest, clientIp, conflict, unauthorized } from "../lib/http.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { generateTotpSecret, otpauthUri, verifyTotp } from "../lib/totp.js";
import { recordAudit } from "../lib/audit.js";
import { SESSION_COOKIE, sessionCookieOptions } from "../plugins/auth.js";

/**
 * A TOTP enrolment that has been generated but not yet confirmed with a valid
 * code is stored with this prefix. A pending secret never satisfies a login
 * challenge, so abandoning enrolment halfway cannot lock anyone out.
 */
const TOTP_PENDING = "pending:";

const isTotpEnabled = (secret: string | null): boolean =>
  Boolean(secret && !secret.startsWith(TOTP_PENDING));

/** Sign-in attempts allowed per client IP per minute. */
const LOGIN_ATTEMPTS_PER_MINUTE = 20;

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/login", async (request, reply) => {
    const body = LoginSchema.parse(request.body);
    const ip = clientIp(request.headers as Record<string, unknown>, request.ip);

    // Brute-force guard, reusing the gateway's sliding-window limiter.
    const limit = checkRateLimit(`login:${ip}`, LOGIN_ATTEMPTS_PER_MINUTE);
    if (!limit.allowed) {
      reply.header("retry-after", String(limit.retryAfterSeconds ?? 60));
      throw new HttpError(429, "Too many sign-in attempts. Try again in a minute.", "rate_limited");
    }

    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });

    // Always run the hash comparison, even for an unknown email, so response
    // timing does not reveal whether an account exists.
    const passwordOk = user
      ? verifyPassword(body.password, user.passwordHash)
      : verifyPassword(body.password, hashPassword("placeholder-for-timing"));

    if (!user || !passwordOk) throw unauthorized("Incorrect email or password");
    if (user.status !== "ACTIVE") throw unauthorized("This account is suspended");

    // Second factor. The password must already be correct before the server
    // reveals that this account expects a TOTP code at all.
    if (isTotpEnabled(user.totpSecret)) {
      if (!body.totpCode) {
        throw new HttpError(401, "Enter the 6-digit code from your authenticator app", "totp_required");
      }
      if (!verifyTotp(user.totpSecret!, body.totpCode)) {
        throw new HttpError(401, "That code is incorrect or has expired", "totp_invalid");
      }
    }

    const { token, expiresAt } = await app.issueSession(user, {
      userAgent: request.headers["user-agent"],
      ip
    });
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await recordAudit({ adminId: user.id, action: "auth.login", targetType: "user", targetId: user.id, ip });

    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
        totpEnabled: isTotpEnabled(user.totpSecret)
      }
    });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await app.destroySession(token);
    if (request.authUser) {
      await recordAudit({
        adminId: request.authUser.id,
        action: "auth.logout",
        targetType: "user",
        targetId: request.authUser.id
      });
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.send({ ok: true });
  });

  app.get("/api/auth/me", async (request) => {
    const user = await app.requireAuth(request);
    const record = await prisma.user.findUnique({
      where: { id: user.id },
      select: { totpSecret: true }
    });
    return { user: { ...user, totpEnabled: isTotpEnabled(record?.totpSecret ?? null) } };
  });

  app.post("/api/auth/password", async (request) => {
    const user = await app.requireAuth(request);
    const body = ChangePasswordSchema.parse(request.body);

    const record = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!verifyPassword(body.currentPassword, record.passwordHash)) {
      throw badRequest("Current password is incorrect");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: hashPassword(body.newPassword) }
    });
    // Changing a password invalidates every other browser session.
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await recordAudit({
      adminId: user.id,
      action: "auth.password_change",
      targetType: "user",
      targetId: user.id
    });

    return { ok: true, message: "Password changed. Sign in again on your other devices." };
  });

  /* ------------------------------------------------------------- 2FA */

  /**
   * Step 1: mint a secret and hold it as pending. It only becomes active once
   * the user proves their authenticator produces matching codes (step 2), so a
   * mis-scanned QR can never lock an account.
   */
  app.post("/api/auth/totp/setup", async (request) => {
    const user = await app.requireAuth(request);
    const record = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (isTotpEnabled(record.totpSecret)) {
      throw conflict("Two-factor authentication is already enabled");
    }

    const secret = generateTotpSecret();
    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecret: `${TOTP_PENDING}${secret}` }
    });

    return { secret, otpauthUri: otpauthUri(user.email, secret) };
  });

  /** Step 2: confirm with a live code; the pending secret becomes active. */
  app.post("/api/auth/totp/enable", async (request) => {
    const user = await app.requireAuth(request);
    const body = TotpEnableSchema.parse(request.body);

    const record = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (isTotpEnabled(record.totpSecret)) {
      throw conflict("Two-factor authentication is already enabled");
    }
    if (!record.totpSecret?.startsWith(TOTP_PENDING)) {
      throw badRequest("Start enrolment first");
    }

    const secret = record.totpSecret.slice(TOTP_PENDING.length);
    if (!verifyTotp(secret, body.code)) {
      throw badRequest("That code is incorrect. Check your authenticator and try again.");
    }

    await prisma.user.update({ where: { id: user.id }, data: { totpSecret: secret } });
    await recordAudit({
      adminId: user.id,
      action: "auth.totp_enable",
      targetType: "user",
      targetId: user.id,
      ip: clientIp(request.headers as Record<string, unknown>, request.ip)
    });

    return { ok: true, message: "Two-factor authentication is on. You will need a code at every sign-in." };
  });

  /** Turning 2FA off demands both factors, so a stolen session is not enough. */
  app.post("/api/auth/totp/disable", async (request) => {
    const user = await app.requireAuth(request);
    const body = TotpDisableSchema.parse(request.body);

    const record = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!isTotpEnabled(record.totpSecret)) {
      throw badRequest("Two-factor authentication is not enabled");
    }
    if (!verifyPassword(body.password, record.passwordHash)) {
      throw badRequest("Password is incorrect");
    }
    if (!verifyTotp(record.totpSecret!, body.code)) {
      throw badRequest("That code is incorrect or has expired");
    }

    await prisma.user.update({ where: { id: user.id }, data: { totpSecret: null } });
    await recordAudit({
      adminId: user.id,
      action: "auth.totp_disable",
      targetType: "user",
      targetId: user.id,
      ip: clientIp(request.headers as Record<string, unknown>, request.ip)
    });

    return { ok: true, message: "Two-factor authentication is off." };
  });
}
