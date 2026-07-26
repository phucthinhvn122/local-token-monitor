import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "node:crypto";
import { prisma } from "@cgw/db";
import { sha256 } from "@cgw/core";
import { env, isCookieSecure } from "../env.js";
import { signSessionToken, verifySessionToken } from "../lib/crypto.js";
import { forbidden, unauthorized } from "../lib/http.js";

export const SESSION_COOKIE = "cgw_session";

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: "ADMIN" | "USER";
  status: "ACTIVE" | "SUSPENDED";
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest) => Promise<AuthUser>;
    requireAdmin: (request: FastifyRequest) => Promise<AuthUser>;
    issueSession: (
      user: { id: string; role: string },
      meta: { userAgent?: string; ip?: string }
    ) => Promise<{ token: string; expiresAt: Date }>;
    destroySession: (token: string) => Promise<void>;
  }
}

async function resolveUser(request: FastifyRequest): Promise<AuthUser | undefined> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return undefined;

  const claims = verifySessionToken(token, env().SESSION_SECRET);
  if (!claims) return undefined;

  // The signature only proves the token is ours. The session row is what makes
  // it valid, so revoking a session takes effect immediately.
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true }
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) return undefined;
  if (session.user.status !== "ACTIVE") return undefined;

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    status: session.user.status
  };
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest("authUser", undefined);

  app.addHook("onRequest", async (request) => {
    // Gateway traffic authenticates with a bearer API key, not a cookie.
    if (request.url.startsWith("/v1/")) return;
    request.authUser = await resolveUser(request);
  });

  app.decorate("requireAuth", async (request: FastifyRequest): Promise<AuthUser> => {
    if (!request.authUser) throw unauthorized();
    return request.authUser;
  });

  app.decorate("requireAdmin", async (request: FastifyRequest): Promise<AuthUser> => {
    if (!request.authUser) throw unauthorized();
    if (request.authUser.role !== "ADMIN") throw forbidden("Administrator access required");
    return request.authUser;
  });

  app.decorate(
    "issueSession",
    async (user: { id: string; role: string }, meta: { userAgent?: string; ip?: string }) => {
      const config = env();
      const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3_600_000);
      const token = signSessionToken(
        { sub: user.id, role: user.role, jti: randomUUID(), exp: Math.floor(expiresAt.getTime() / 1000) },
        config.SESSION_SECRET
      );
      await prisma.session.create({
        data: {
          userId: user.id,
          tokenHash: sha256(token),
          userAgent: meta.userAgent?.slice(0, 300) ?? null,
          ip: meta.ip ?? null,
          expiresAt
        }
      });
      return { token, expiresAt };
    }
  );

  app.decorate("destroySession", async (token: string) => {
    await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
  });
});

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: isCookieSecure(env()),
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt
  };
}
