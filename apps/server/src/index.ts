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
import {
  bundledProviderConfigs,
  createQuotaAdapter,
  fetchAntigravityQuotaStatus,
  fetchNxtCodexQuotaStatus,
  NttCodexBrowserBridge,
  PublicQuotaPublisher,
  providerResearch
} from "@ltm/provider-quota";
import { safeError } from "@ltm/core";
import {
  ThirdPartyProviderIdSchema,
  type AppSettings,
  type ThirdPartyProviderConfig,
  type UsageFilters
} from "@ltm/shared-types";

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
  providerNetworkEnabled: z.boolean().optional(),
  customProviderPaths: z.array(z.string().max(1000)).max(30).optional(),
  customLogPaths: z.array(z.string().max(1000)).max(30).optional()
}).strict();

const HttpsUrlSchema = z.string().url().refine((value) => {
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
}, "URL must be public HTTPS and contain no credentials or query parameters");
const ThirdPartyConfigPatchSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  baseUrl: HttpsUrlSchema.nullable().optional(),
  quotaEndpoint: HttpsUrlSchema.nullable().optional(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).nullable().optional(),
  protocol: z.enum(["openai", "anthropic", "unknown"]).optional(),
  enabled: z.boolean().optional(),
  refreshIntervalMinutes: z.number().int().min(1).max(1440).optional()
}).strict();

function parseFilters(request: FastifyRequest): UsageFilters {
  return QuerySchema.parse(request.query);
}

export async function startServer(options: { port?: number; host?: string; openBrowser?: boolean } = {}) {
  const database = new MonitorDatabase();
  database.ensureThirdPartyProviderConfigs(bundledProviderConfigs);
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
  const publicQuotaPublisher = await PublicQuotaPublisher.fromRuntime();
  const nttcodexBrowser = new NttCodexBrowserBridge({
    onSnapshot: async (snapshot) => {
      database.saveProviderQuotaSnapshot(snapshot);
      publish({
        type: "provider-quota",
        provider: "nttcodex",
        message: `NTTCodex: ${snapshot.status}`,
        timestamp: snapshot.fetchedAt
      });
      await publicQuotaPublisher.publish(snapshot);
    }
  });
  const customPaths = [...settings.customProviderPaths, ...settings.customLogPaths];
  const adapters = [
    new CodexAdapter(customPaths.filter((candidate) => /codex/i.test(candidate))),
    new ClaudeAdapter(customPaths.filter((candidate) => /claude|anthropic/i.test(candidate)))
  ];
  const manager = new CollectorManager(database, adapters, publish);
  let collectorError: string | undefined;

  const thirdPartyView = async (config: ThirdPartyProviderConfig) => {
    const adapter = createQuotaAdapter(config);
    return {
      config,
      research: providerResearch[config.id],
      detection: await adapter.detect(),
      capabilities: adapter.capabilities(),
      diagnostics: adapter.diagnostics(),
      credentialConfigured: Boolean(config.apiKeyEnv && process.env[config.apiKeyEnv]),
      browserBridge: config.id === "nttcodex" ? nttcodexBrowser.status() : undefined,
      snapshot: database.providerQuotaSnapshot(config.id)
    };
  };

  app.get("/api/health", async () => ({
    status: "ok",
    pid: process.pid,
    timestamp: new Date().toISOString(),
    localOnly: host === "127.0.0.1"
  }));

  app.get("/api/quota", async (request) => {
    const provider = (request.query as { provider?: string })?.provider === "antigravity" ? "antigravity" : "nxtcodex";
    let latest = database.getLatestQuotaStatus(provider);
    if (!latest) {
      const providerNetworkEnabled =
        process.env.LTM_PROVIDER_NETWORK === "true" ||
        database.getSettings().providerNetworkEnabled;
      latest = provider === "antigravity"
        ? await fetchAntigravityQuotaStatus({ allowNetwork: providerNetworkEnabled })
        : await fetchNxtCodexQuotaStatus({ allowNetwork: providerNetworkEnabled });
      database.saveQuotaStatus(latest);
    }
    return latest;
  });

  app.post("/api/quota/refresh", async (request) => {
    const provider = (request.query as { provider?: string })?.provider === "antigravity" ? "antigravity" : "nxtcodex";
    const providerNetworkEnabled =
      process.env.LTM_PROVIDER_NETWORK === "true" ||
      database.getSettings().providerNetworkEnabled;
    const quota = provider === "antigravity"
      ? await fetchAntigravityQuotaStatus({ allowNetwork: providerNetworkEnabled })
      : await fetchNxtCodexQuotaStatus({ allowNetwork: providerNetworkEnabled });
    database.saveQuotaStatus(quota);
    publish({
      type: "provider-quota",
      provider,
      message: `${provider.toUpperCase()}: ${quota.status}`,
      timestamp: quota.checkedAt
    });
    return quota;
  });

  app.get("/api/quota/history", async (request) => {
    const provider = (request.query as { provider?: string })?.provider === "antigravity" ? "antigravity" : "nxtcodex";
    const limit = Number((request.query as { limit?: string })?.limit || 50);
    const history = database.getQuotaHistory(provider, limit);

    // Compute consumption stats
    const valid = [...history]
      .filter((item) => item.remaining !== null && item.checkedAt)
      .sort((a, b) => new Date(a.checkedAt).getTime() - new Date(b.checkedAt).getTime());

    let avgRatePerMinute = 0;
    let avgRatePerHour = 0;
    let estimatedDepletionAt: string | null = null;
    let estimatedSecondsUntilDepletion: number | null = null;

    if (valid.length >= 2) {
      const first = valid[0];
      const last = valid[valid.length - 1];
      const elapsedMs = new Date(last.checkedAt).getTime() - new Date(first.checkedAt).getTime();
      if (elapsedMs > 0) {
        let totalConsumed = 0;
        for (let i = 1; i < valid.length; i++) {
          const prevRem = valid[i - 1].remaining!;
          const currRem = valid[i].remaining!;
          if (currRem < prevRem) {
            totalConsumed += (prevRem - currRem);
          }
        }
        const elapsedMinutes = elapsedMs / 60_000;
        avgRatePerMinute = elapsedMinutes > 0 ? Number((totalConsumed / elapsedMinutes).toFixed(2)) : 0;
        avgRatePerHour = Number((avgRatePerMinute * 60).toFixed(2));
        if (avgRatePerMinute > 0 && last.remaining !== null && last.remaining > 0) {
          const minutesRemaining = last.remaining / avgRatePerMinute;
          estimatedSecondsUntilDepletion = Math.floor(minutesRemaining * 60);
          estimatedDepletionAt = new Date(Date.now() + estimatedSecondsUntilDepletion * 1000).toISOString();
        }
      }
    }

    return {
      provider,
      history,
      stats: {
        avgRatePerMinute,
        avgRatePerHour,
        estimatedDepletionAt,
        estimatedSecondsUntilDepletion
      }
    };
  });

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
  app.get("/api/third-party/providers", async () =>
    Promise.all(database.thirdPartyProviderConfigs().map(thirdPartyView))
  );
  app.get("/api/third-party/providers/:id", async (request, reply) => {
    const id = ThirdPartyProviderIdSchema.parse((request.params as { id: string }).id);
    const config = database.thirdPartyProviderConfigs().find((item) => item.id === id);
    return config ? thirdPartyView(config) : reply.code(404).send({ error: "Third-party provider not found" });
  });
  app.patch("/api/third-party/providers/:id", async (request, reply) => {
    const id = ThirdPartyProviderIdSchema.parse((request.params as { id: string }).id);
    const body = ThirdPartyConfigPatchSchema.parse(request.body);
    const existing = database.thirdPartyProviderConfigs().find((item) => item.id === id);
    if (!existing) return reply.code(404).send({ error: "Third-party provider not found" });
    const patch: Partial<ThirdPartyProviderConfig> = { ...body } as Partial<ThirdPartyProviderConfig>;
    if ("baseUrl" in body) patch.baseUrl = body.baseUrl ?? undefined;
    if ("quotaEndpoint" in body) patch.quotaEndpoint = body.quotaEndpoint ?? undefined;
    if ("apiKeyEnv" in body) patch.apiKeyEnv = body.apiKeyEnv ?? undefined;
    if ("quotaEndpoint" in body && body.quotaEndpoint !== existing.quotaEndpoint) patch.endpointVerified = false;
    const updated = database.updateThirdPartyProviderConfig(id, patch);
    database.deleteProviderQuotaSnapshot(id);
    publish({ type: "settings", provider: id, message: `${updated.displayName} provider settings updated`, timestamp: new Date().toISOString() });
    return thirdPartyView(updated);
  });
  app.post("/api/third-party/providers/:id/discover", async (request, reply) => {
    const id = ThirdPartyProviderIdSchema.parse((request.params as { id: string }).id);
    const { level } = z.object({ level: z.number().int().min(0).max(3).default(0) }).parse(request.body ?? {});
    const config = database.thirdPartyProviderConfigs().find((item) => item.id === id);
    if (!config) return reply.code(404).send({ error: "Third-party provider not found" });
    const adapter = createQuotaAdapter(config);
    return {
      requestedLevel: level,
      executedLevel: 0,
      networkRequestSent: false,
      notice: level === 0
        ? "Public documentation research only."
        : "Levels 1-3 require explicit endpoint and credential authorization; only Level 0 was executed.",
      detection: await adapter.detect(),
      capabilities: adapter.capabilities(),
      diagnostics: adapter.diagnostics(),
      research: providerResearch[id]
    };
  });
  app.get("/api/third-party/providers/nttcodex/browser", async () => nttcodexBrowser.status());
  app.get("/api/public-relay/status", async () => publicQuotaPublisher.status());
  app.post("/api/third-party/providers/nttcodex/browser/connect", async (request, reply) => {
    if (host !== "127.0.0.1") {
      return reply.code(403).send({ error: "Browser connection is available only on the local-only server." });
    }
    const body = z.object({
      confirm: z.literal("CONNECT NTTCODEX"),
      refreshSeconds: z.number().int().min(10).max(300).default(30)
    }).strict().parse(request.body);
    try {
      const snapshot = await nttcodexBrowser.connect(body.refreshSeconds);
      return { snapshot, browserBridge: nttcodexBrowser.status() };
    } catch (error) {
      return reply.code(409).send({
        error: safeError(error),
        browserBridge: nttcodexBrowser.status()
      });
    }
  });
  app.post("/api/third-party/providers/nttcodex/browser/refresh", async (request, reply) => {
    z.object({ confirm: z.literal("REFRESH NTTCODEX") }).strict().parse(request.body);
    try {
      const snapshot = await nttcodexBrowser.refresh();
      return { snapshot, browserBridge: nttcodexBrowser.status() };
    } catch (error) {
      return reply.code(409).send({
        error: safeError(error),
        browserBridge: nttcodexBrowser.status()
      });
    }
  });
  app.post("/api/third-party/providers/nttcodex/browser/disconnect", async (request) => {
    z.object({ confirm: z.literal("DISCONNECT NTTCODEX") }).strict().parse(request.body);
    await nttcodexBrowser.disconnect();
    return { ok: true, browserBridge: nttcodexBrowser.status() };
  });
  app.post("/api/third-party/providers/:id/refresh", async (request, reply) => {
    const id = ThirdPartyProviderIdSchema.parse((request.params as { id: string }).id);
    const config = database.thirdPartyProviderConfigs().find((item) => item.id === id);
    if (!config) return reply.code(404).send({ error: "Third-party provider not found" });
    const previous = database.providerQuotaSnapshot(id);
    if (previous?.retryAfterAt && new Date(previous.retryAfterAt).getTime() > Date.now()) {
      return reply.code(429).send({
        error: "Refresh is paused until the provider Retry-After time.",
        retryAfterAt: previous.retryAfterAt,
        snapshot: previous
      });
    }
    if (previous) {
      const nextManualRefreshAt = new Date(
        new Date(previous.fetchedAt).getTime() + config.refreshIntervalMinutes * 60_000
      );
      if (nextManualRefreshAt.getTime() > Date.now()) {
        return reply.code(429).send({
          error: `Manual refresh is limited to once every ${config.refreshIntervalMinutes} minute(s).`,
          retryAfterAt: nextManualRefreshAt.toISOString(),
          snapshot: previous
        });
      }
    }
    const providerNetworkEnabled =
      process.env.LTM_PROVIDER_NETWORK === "true" ||
      database.getSettings().providerNetworkEnabled;
    const snapshot = await createQuotaAdapter(config).fetchQuota({ allowNetwork: providerNetworkEnabled });
    database.saveProviderQuotaSnapshot(snapshot);
    publish({
      type: "provider-quota",
      provider: id,
      message: `${config.displayName}: ${snapshot.status}`,
      timestamp: snapshot.fetchedAt
    });
    return { snapshot, networkEnabled: providerNetworkEnabled };
  });
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
  const handleSettingsUpdate = async (request: FastifyRequest) => {
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
  };

  app.patch("/api/settings", handleSettingsUpdate);
  app.put("/api/settings", handleSettingsUpdate);
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
    thirdPartyProviders: database.thirdPartyProviderConfigs().map((config) => createQuotaAdapter(config).diagnostics()),
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
      thirdPartyProviders: database.thirdPartyProviderConfigs().map((config) => createQuotaAdapter(config).diagnostics()),
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
      path.resolve(process.cwd(), "apps/web/dist"),
      path.resolve(process.cwd(), "dist")
    ];
    const webRoot = candidates.find((candidate) => existsSync(path.join(candidate, "index.html")));
    if (webRoot) {
      await app.register(fastifyStatic, {
        root: webRoot,
        prefix: "/",
        wildcard: false,
        decorateReply: true,
        serve: false
      });

      // Explicit route for asset files — must be registered BEFORE setNotFoundHandler
      app.get("/assets/*", (request, reply) => {
        const assetPath = (request.params as { "*": string })["*"];
        return reply.sendFile(`assets/${assetPath}`);
      });

      app.setNotFoundHandler((request, reply) => {
        if (request.raw.url?.startsWith("/api/")) {
          return reply.code(404).send({ error: "Not found" });
        }
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
    await nttcodexBrowser.disconnect();
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
  const previousNttCodexSnapshot = database.providerQuotaSnapshot("nttcodex");
  if (previousNttCodexSnapshot) void publicQuotaPublisher.publish(previousNttCodexSnapshot);
  if (publicQuotaPublisher.status().configured) {
    void nttcodexBrowser.connect(30).catch((error) => {
      app.log.warn({ error: safeError(error) }, "NTTCodex automatic connection is waiting for the local browser session");
    });
  }

  return { app, url: `http://${host}:${port}`, database };
}
