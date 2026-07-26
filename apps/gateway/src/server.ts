import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { z } from "zod";
import { prisma } from "@cgw/db";
import { safeError } from "@cgw/core";
import { env, type Env } from "./env.js";
import { HttpError } from "./lib/http.js";
import { authPlugin } from "./plugins/auth.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { meRoutes } from "./routes/me.js";
import { gatewayRoutes } from "./routes/gateway.js";
import { hashPassword } from "./lib/crypto.js";

/**
 * Create the first administrator on an empty database so a fresh deployment is
 * reachable. Skipped entirely once any admin exists, so it can never reset a
 * password on an existing installation.
 */
export async function ensureBootstrapAdmin(config: Env, log: FastifyInstance["log"]): Promise<void> {
  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) return;
  if ((await prisma.user.count({ where: { role: "ADMIN" } })) > 0) return;

  const email = config.ADMIN_EMAIL.toLowerCase();
  await prisma.user.create({
    data: {
      email,
      name: "Administrator",
      role: "ADMIN",
      passwordHash: hashPassword(config.ADMIN_PASSWORD)
    }
  });
  log.warn({ email }, "Bootstrap administrator created — sign in and change this password");
}

export async function buildServer(config: Env = env()): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-api-key']",
        "res.headers['set-cookie']"
      ]
    },
    // Codex sends large contexts; the default 1 MB limit rejects real requests.
    bodyLimit: 32 * 1024 * 1024,
    trustProxy: true,
    // Codex streams for a long time; do not cut a live response short.
    connectionTimeout: 0,
    keepAliveTimeout: 75_000,
    requestTimeout: 0
  });

  await app.register(cors, {
    origin: config.WEB_ORIGIN.split(",").map((value) => value.trim()).filter(Boolean),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
  });
  await app.register(cookie);
  await app.register(authPlugin);

  app.get("/api/health", async () => {
    let database = "ok";
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      database = safeError(error);
    }
    return { status: database === "ok" ? "ok" : "degraded", database, timestamp: new Date().toISOString() };
  });

  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(meRoutes);
  await app.register(gatewayRoutes);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: "Validation failed",
        code: "validation_error",
        details: error.flatten()
      });
    }
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: error.message,
        code: error.code,
        details: error.details
      });
    }

    // Prisma surfaces unique-constraint and missing-row failures as codes.
    const prismaCode = (error as { code?: string }).code;
    if (prismaCode === "P2002") return reply.code(409).send({ error: "That value is already in use", code: "conflict" });
    if (prismaCode === "P2025") return reply.code(404).send({ error: "Not found", code: "not_found" });

    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ error: safeError(error), url: request.url }, "Unhandled server error");
      return reply.code(500).send({ error: "Internal server error", code: "internal_error" });
    }
    return reply.code(statusCode).send({ error: safeError(error), code: "request_error" });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: `No route for ${request.method} ${request.url}`, code: "not_found" })
  );

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  return app;
}
