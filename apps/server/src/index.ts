import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { MonitorDatabase } from "@ltm/database";
import { CollectorManager } from "@ltm/collectors";
import { CodexAdapter } from "@ltm/provider-codex";
import { ClaudeAdapter } from "@ltm/provider-claude";
import { safeError } from "@ltm/core";
import type { AppSettings, UsageFilters } from "@ltm/shared-types";

const QuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  provider: z.enum(["codex", "claude"]).optional(),
  projectId: z.string().max(200).optional(),
  sessionId: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  accuracy: z.enum(["exact", "derived", "estimated", "unavailable"]).optional(),
  interval: z.enum(["5m", "15m", "hour", "6h", "day"]).optional()
});

const SettingsPatchSchema = z.object({
  port: z.number().int().min(1024).max(65535).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  pollingIntervalMs: z.number().int().min(1000).max(300_000).optional(),
  codexCollectorEnabled: z.boolean().optional(),
  claudeCollectorEnabled: z.boolean().optional(),
  tokenEstimationEnabled: z.boolean().optional(),
  costEstimationEnabled: z.boolean().optional(),
  privacyMode: z.boolean().optional(),
  demoMode: z.boolean().optional(),
  allowNetwork: z.boolean().optional(),
  customProviderPaths: z.array(z.string().max(1000)).max(30).optional(),
  customLogPaths: z.array(z.string().max(1000)).max(30).optional()
}).strict();

function parseFilters(request: FastifyRequest): UsageFilters {
  return QuerySchema.parse(request.query);
}

export async function startServer(options: { port?: number; host?: string; openBrowser?: boolean } = {}) {
  const database = new MonitorDatabase();
  const settings = database.getSettings();
  const port = options.port ?? Number(process.env.LTM_PORT || settings.port || 3456);
  const requestedHost = options.host ?? process.env.LTM_HOST ?? "127.0.0.1";
  const allowNetwork = process.env.LTM_ALLOW_NETWORK === "true" || settings.allowNetwork;
  const host = allowNetwork ? requestedHost : "127.0.0.1";
  const app = Fastify({
    logger: {
      level: process.env.LTM_LOG_LEVEL ?? "warn",
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers.x-api-key"]
    },
    bodyLimit: 1_000_000
  });
  await app.register(cors, { origin: false });

  const clients = new Set<FastifyReply>();
  const runtimeActivity: Array<Record<string, unknown>> = [];
  const publish = (event: { type: string; provider?: string; message: string; timestamp: string }) => {
    runtimeActivity.unshift(event);
    runtimeActivity.splice(50);
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.raw.write(payload);
  };
  const customPaths = [...settings.customProviderPaths, ...settings.customLogPaths];
  const adapters = [
    new CodexAdapter(customPaths.filter((candidate) => /codex/i.test(candidate))),
    new ClaudeAdapter(customPaths.filter((candidate) => /claude|anthropic/i.test(candidate)))
  ];
  const manager = new CollectorManager(database, adapters, publish);
  let collectorError: string | undefined;

  app.get("/api/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    localOnly: host === "127.0.0.1"
  }));

  app.get("/api/status", async () => {
    const diagnostics = await manager.diagnostics().catch((error) => {
      collectorError = safeError(error);
      return [];
    });
    const sessions = database.sessions();
    return {
      server: "online",
      host,
      port,
      startedAt: new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      activeCollectors: diagnostics.filter((item: any) => item.installation?.installed).length,
      activeSessions: sessions.filter((session) => session.status === "running").length,
      providers: diagnostics,
      collectorError
    };
  });

  app.get("/api/providers", async (request) => database.breakdown(parseFilters(request)));
  app.get("/api/projects", async () => database.projects());
  app.get("/api/projects/:id", async (request, reply) => {
    const result = database.project((request.params as { id: string }).id);
    return result ?? reply.code(404).send({ error: "Project not found" });
  });
  app.patch("/api/projects/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const body = z.object({ displayName: z.string().trim().min(1).max(80).optional(), hidden: z.boolean().optional() }).parse(request.body);
    if (body.displayName) database.renameProject(params.id, body.displayName);
    if (body.hidden) database.hideProject(params.id);
    return reply.send({ ok: true });
  });
  app.get("/api/sessions", async (request) => database.sessions(parseFilters(request)));
  app.get("/api/sessions/:id", async (request, reply) => {
    const result = database.sessions({ sessionId: (request.params as { id: string }).id })[0];
    return result ?? reply.code(404).send({ error: "Session not found" });
  });
  app.get("/api/usage/summary", async (request) => database.summary(parseFilters(request)));
  app.get("/api/usage/timeline", async (request) => database.timeline(parseFilters(request)));
  app.get("/api/usage/breakdown", async (request) => database.breakdown(parseFilters(request)));
  app.get("/api/activity", async () => [...runtimeActivity, ...database.activity()].slice(0, 16));
  app.get("/api/settings", async () => ({ ...database.getSettings(), pricing: database.getPricing() }));
  app.patch("/api/settings", async (request) => {
    const body = SettingsPatchSchema.parse(request.body);
    const updated = database.updateSettings(body as Partial<AppSettings>);
    const collectorSettings = [
      "demoMode",
      "codexCollectorEnabled",
      "claudeCollectorEnabled",
      "customProviderPaths",
      "customLogPaths"
    ];
    if (collectorSettings.some((key) => key in body)) {
      await manager.stop();
      await manager.start();
    }
    publish({ type: "settings", message: "Settings updated locally", timestamp: new Date().toISOString() });
    return { ...updated, pricing: database.getPricing(), restartRequired: body.port !== undefined || body.allowNetwork !== undefined };
  });
  app.put("/api/settings/pricing", async (request) => {
    const pricing = z.array(z.object({
      provider: z.enum(["openai", "anthropic"]),
      modelPattern: z.string().min(1).max(200),
      inputPerMillion: z.number().nonnegative(),
      outputPerMillion: z.number().nonnegative(),
      cacheReadPerMillion: z.number().nonnegative().optional(),
      cacheWritePerMillion: z.number().nonnegative().optional(),
      effectiveFrom: z.string(),
      sourceUrl: z.string().url().optional()
    })).max(100).parse(request.body);
    database.replacePricing(pricing);
    return { ok: true, pricing: database.getPricing() };
  });
  app.get("/api/diagnostics", async () => ({
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    nodeVersion: process.version,
    databasePath: settings.privacyMode ? "[private database path]" : database.path,
    collectors: await manager.diagnostics(),
    collectorError,
    localOnly: host === "127.0.0.1"
  }));
  app.get("/api/diagnostics/report", async (_request, reply) => {
    const report = {
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      nodeVersion: process.version,
      collectors: await manager.diagnostics(),
      settings: { ...database.getSettings(), databasePath: "[REDACTED]", customProviderPaths: [], customLogPaths: [] }
    };
    reply.header("content-disposition", 'attachment; filename="local-token-monitor-diagnostics.json"');
    return reply.type("application/json").send(JSON.stringify(report, null, 2));
  });
  app.get("/api/export", async (request, reply) => {
    const format = z.object({ format: z.enum(["json", "csv"]).default("json") }).parse(request.query).format;
    const output = database.exportData(format);
    reply.header("content-disposition", `attachment; filename="local-token-usage.${format}"`);
    return reply.type(format === "csv" ? "text/csv" : "application/json").send(output);
  });
  app.delete("/api/data", async (request) => {
    z.object({ confirmation: z.literal("DELETE ALL LOCAL DATA") }).parse(request.body);
    database.reset(false);
    publish({ type: "reset", message: "Local data reset; demo data restored", timestamp: new Date().toISOString() });
    return { ok: true };
  });
  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
    clients.add(reply);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 20_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(reply);
    });
  });

  if (process.env.LTM_DEV !== "true") {
    const candidates = [
      path.resolve(import.meta.dirname, "../../web/dist"),
      path.resolve(import.meta.dirname, "../apps/web/dist"),
      path.resolve(process.cwd(), "apps/web/dist")
    ];
    const webRoot = candidates.find((candidate) => existsSync(path.join(candidate, "index.html")));
    if (webRoot) {
      await app.register(fastifyStatic, { root: webRoot, wildcard: false });
      app.setNotFoundHandler((request, reply) => {
        if (request.raw.url?.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
        return reply.sendFile("index.html");
      });
    }
  }

  app.setErrorHandler((error, _request, reply) => {
    const knownError = error as Error & { statusCode?: number };
    const status = error instanceof z.ZodError ? 400 : (knownError.statusCode ?? 500);
    reply.code(status).send({
      error: status === 500 ? "Internal server error" : knownError.message,
      details: error instanceof z.ZodError ? error.flatten() : undefined
    });
  });

  const close = async () => {
    await manager.stop();
    database.close();
  };
  app.addHook("onClose", close);

  await app.listen({ port, host });
  const runtimeDir = path.join(os.homedir(), ".local-token-monitor");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(path.join(runtimeDir, "server.json"), JSON.stringify({ pid: process.pid, host, port, startedAt: new Date().toISOString() }));
  void manager.start().catch((error) => {
    collectorError = safeError(error);
    app.log.warn({ error: collectorError }, "Collector manager degraded");
  });

  return { app, url: `http://${host}:${port}`, database };
}
