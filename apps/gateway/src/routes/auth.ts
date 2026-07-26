import type { FastifyInstance } from "fastify";
import { prisma } from "@cgw/db";
import { ChangePasswordSchema, LoginSchema } from "@cgw/shared";
import { hashPassword, verifyPassword } from "../lib/crypto.js";
import { badRequest, clientIp, unauthorized } from "../lib/http.js";
import { recordAudit } from "../lib/audit.js";
import { SESSION_COOKIE, sessionCookieOptions } from "../plugins/auth.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/login", async (request, reply) => {
    const body = LoginSchema.parse(request.body);
    const ip = clientIp(request.headers as Record<string, unknown>, request.ip);

    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });

    // Always run the hash comparison, even for an unknown email, so response
    // timing does not reveal whether an account exists.
    const passwordOk = user
      ? verifyPassword(body.password, user.passwordHash)
      : verifyPassword(body.password, hashPassword("placeholder-for-timing"));

    if (!user || !passwordOk) throw unauthorized("Incorrect email or password");
    if (user.status !== "ACTIVE") throw unauthorized("This account is suspended");

    const { token, expiresAt } = await app.issueSession(user, {
      userAgent: request.headers["user-agent"],
      ip
    });
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await recordAudit({ adminId: user.id, action: "auth.login", targetType: "user", targetId: user.id, ip });

    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
    return reply.send({
      user: { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status }
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
    return { user };
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
}
