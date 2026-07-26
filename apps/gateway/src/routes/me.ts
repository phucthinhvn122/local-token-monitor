import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma, prisma, asNumber } from "@cgw/db";
import {
  CodexSetupQuerySchema,
  LogQuerySchema,
  StatsQuerySchema,
  buildCodexConfig,
  codexManualSteps
} from "@cgw/shared";
import { maskKey as maskKeyPrefix } from "../lib/api-key.js";
import { env } from "../env.js";
import { decryptSecret, parseEncryptionKey } from "../lib/crypto.js";
import { forbidden, notFound } from "../lib/http.js";
import { buildQuotaSummary, usedPercent } from "../lib/quota.js";
import { loadSettings } from "../lib/settings.js";
import { usageTimeseries } from "../lib/stats.js";

const DEFAULT_ENV_KEY = "CODEX_GATEWAY_API_KEY";

/**
 * Process-local plaintext cache, populated when a key is issued or rotated.
 *
 * It is the only source of the plaintext when STRICT_ONE_TIME_KEYS is on, and
 * a free fast path otherwise. It is intentionally not shared between replicas:
 * losing it degrades to "issue a new key", never to a wrong key.
 */
const plaintextCache = new Map<string, string>();

export function rememberPlaintext(apiKeyId: string, plaintext: string): void {
  plaintextCache.set(apiKeyId, plaintext);
}

/**
 * Recover a usable plaintext key: memory first, then the encrypted column.
 * Returns undefined in strict mode once the issuing process has gone.
 */
function recallPlaintext(key: { id: string; keyEncrypted: string | null }): string | undefined {
  const cached = plaintextCache.get(key.id);
  if (cached) return cached;
  if (!key.keyEncrypted) return undefined;
  try {
    const plaintext = decryptSecret(key.keyEncrypted, parseEncryptionKey(env().ENCRYPTION_KEY));
    plaintextCache.set(key.id, plaintext);
    return plaintext;
  } catch {
    // A rotated ENCRYPTION_KEY makes old ciphertext unreadable. That is a
    // recoverable state (issue a new key), not a request failure.
    return undefined;
  }
}

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (request) => {
    await app.requireAuth(request);
  });

  /** Personal dashboard: quota ring, burn rate, projection, usage trend. */
  app.get("/api/me/dashboard", async (request) => {
    const user = await app.requireAuth(request);
    const query = StatsQuerySchema.parse(request.query);
    const settings = await loadSettings();

    const keys = await prisma.apiKey.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" }
    });

    const timeseries = await usageTimeseries({ range: query.range, bucket: query.bucket, userId: user.id });
    const daily =
      query.range === "24h"
        ? await usageTimeseries({ range: "30d", bucket: "day", userId: user.id })
        : timeseries;

    const active = keys.filter((key) => key.status === "ACTIVE");
    const totals = active.reduce(
      (acc, key) => ({
        tokenQuota: acc.tokenQuota + asNumber(key.tokenQuota),
        tokenUsed: acc.tokenUsed + asNumber(key.tokenUsed)
      }),
      { tokenQuota: 0, tokenUsed: 0 }
    );

    const recentRequests = await prisma.usageLog.count({
      where: { apiKey: { userId: user.id }, createdAt: { gte: new Date(Date.now() - 86_400_000) } }
    });

    return {
      quota: buildQuotaSummary(totals, daily, settings.quotaWarnPercent),
      warnPercent: settings.quotaWarnPercent,
      requestsLast24h: recentRequests,
      timeseries,
      keys: keys.map((key) => {
        const tokenQuota = asNumber(key.tokenQuota);
        const tokenUsed = asNumber(key.tokenUsed);
        return {
          id: key.id,
          name: key.name,
          maskedKey: maskKeyPrefix(key.keyPrefix),
          status: key.status,
          tokenQuota,
          tokenUsed,
          tokenRemaining: Math.max(0, tokenQuota - tokenUsed),
          usedPercent: usedPercent({ tokenQuota, tokenUsed }),
          expiresAt: key.expiresAt?.toISOString() ?? null,
          lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
          createdAt: key.createdAt.toISOString(),
          /** True while a working Codex config can still be generated. */
          setupAvailable: Boolean(plaintextCache.has(key.id) || key.keyEncrypted)
        };
      })
    };
  });

  /** Personal request log with the same filters the admin view offers. */
  app.get("/api/me/logs", async (request) => {
    const user = await app.requireAuth(request);
    const query = LogQuerySchema.parse(request.query);

    const where: Prisma.UsageLogWhereInput = {
      apiKey: { userId: user.id },
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {})
            }
          }
        : {}),
      ...(query.model ? { model: { contains: query.model, mode: "insensitive" as const } } : {}),
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.status === "error"
        ? { OR: [{ statusCode: { gte: 400 } }, { statusCode: 0 }] }
        : query.status === "success"
          ? { statusCode: { gte: 200, lt: 400 } }
          : {})
    };

    const [total, logs] = await Promise.all([
      prisma.usageLog.count({ where }),
      prisma.usageLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      })
    ]);

    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      items: logs.map((log) => ({
        id: log.id,
        createdAt: log.createdAt.toISOString(),
        model: log.model,
        endpoint: log.endpoint,
        sessionId: log.sessionId,
        streamed: log.streamed,
        inputTokens: log.inputTokens,
        outputTokens: log.outputTokens,
        cachedTokens: log.cachedTokens,
        totalTokens: log.totalTokens,
        accuracy: log.accuracy,
        latencyMs: log.latencyMs,
        statusCode: log.statusCode,
        errorMessage: log.errorMessage
      }))
    };
  });

  /** Requests grouped into working sessions, when the client sends a session id. */
  app.get("/api/me/sessions", async (request) => {
    const user = await app.requireAuth(request);
    const rows = await prisma.usageLog.groupBy({
      by: ["sessionId"],
      where: { apiKey: { userId: user.id }, sessionId: { not: null } },
      _count: { _all: true },
      _sum: { totalTokens: true, inputTokens: true, outputTokens: true },
      _min: { createdAt: true },
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: "desc" } },
      take: 50
    });

    return {
      items: rows.map((row) => ({
        sessionId: row.sessionId,
        requests: row._count._all,
        totalTokens: row._sum.totalTokens ?? 0,
        inputTokens: row._sum.inputTokens ?? 0,
        outputTokens: row._sum.outputTokens ?? 0,
        startedAt: row._min.createdAt?.toISOString() ?? null,
        endedAt: row._max.createdAt?.toISOString() ?? null
      }))
    };
  });

  app.get("/api/me/logs/export", async (request, reply) => {
    const user = await app.requireAuth(request);
    const query = LogQuerySchema.parse({ ...(request.query as object), page: 1, pageSize: 1 });

    const logs = await prisma.usageLog.findMany({
      where: {
        apiKey: { userId: user.id },
        ...(query.from ? { createdAt: { gte: new Date(query.from) } } : {}),
        ...(query.to ? { createdAt: { lte: new Date(query.to) } } : {})
      },
      orderBy: { createdAt: "desc" },
      take: 50_000
    });

    const headers = [
      "created_at", "model", "endpoint", "session_id", "streamed", "input_tokens",
      "output_tokens", "cached_tokens", "total_tokens", "accuracy", "latency_ms", "status_code"
    ];
    const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = logs.map((log) =>
      [
        log.createdAt.toISOString(), log.model, log.endpoint, log.sessionId, log.streamed,
        log.inputTokens, log.outputTokens, log.cachedTokens, log.totalTokens, log.accuracy,
        log.latencyMs, log.statusCode
      ]
        .map(escape)
        .join(",")
    );

    reply.header("content-disposition", 'attachment; filename="my-usage-logs.csv"');
    return reply.type("text/csv").send([headers.join(","), ...rows].join("\n"));
  });

  /* --------------------------------------------------- Codex CLI setup */

  /**
   * Resolve which key the setup page should configure, preferring an explicit
   * id, then the newest active key whose plaintext is still available.
   */
  async function resolveSetupKey(userId: string, apiKeyId?: string) {
    const keys = await prisma.apiKey.findMany({
      where: { userId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" }
    });
    if (keys.length === 0) throw notFound("You do not have an active API key yet");

    if (apiKeyId) {
      const match = keys.find((key) => key.id === apiKeyId);
      if (!match) throw forbidden("That API key does not belong to you");
      return match;
    }
    return keys.find((key) => plaintextCache.has(key.id) || key.keyEncrypted) ?? keys[0];
  }

  app.get("/api/me/codex-setup", async (request) => {
    const user = await app.requireAuth(request);
    const query = CodexSetupQuerySchema.parse(request.query);
    const settings = await loadSettings();
    const key = await resolveSetupKey(user.id, query.apiKeyId);

    const plaintext = recallPlaintext(key);
    const gatewayBaseUrl = settings.gatewayPublicUrl ?? env().PUBLIC_GATEWAY_URL;
    const wireApi = "chat" as const;

    // Without the plaintext, still render the exact shape of the files with an
    // unmistakable placeholder, so the page is useful for verification.
    const apiKey = plaintext ?? `${key.keyPrefix}<REST-OF-YOUR-KEY>`;

    const bundle = buildCodexConfig(
      {
        gatewayBaseUrl,
        apiKey,
        model: query.model ?? settings.defaultModel,
        wireApi,
        envKey: DEFAULT_ENV_KEY
      },
      query.mode
    );

    return {
      mode: query.mode,
      keyAvailable: Boolean(plaintext),
      apiKeyId: key.id,
      maskedKey: maskKeyPrefix(key.keyPrefix),
      gatewayBaseUrl,
      model: query.model ?? settings.defaultModel,
      envKey: DEFAULT_ENV_KEY,
      bundle,
      steps: codexManualSteps(bundle, DEFAULT_ENV_KEY)
    };
  });

  /**
   * Download both files as a zip. A minimal store-only (uncompressed) zip is
   * assembled by hand: two small text files do not justify a dependency, and
   * every unzip implementation reads stored entries.
   */
  app.get("/api/me/codex-setup/download", async (request, reply) => {
    const user = await app.requireAuth(request);
    const query = CodexSetupQuerySchema.parse(request.query);
    const settings = await loadSettings();
    const key = await resolveSetupKey(user.id, query.apiKeyId);

    const plaintext = recallPlaintext(key);
    if (!plaintext) {
      throw notFound(
        "The full key is no longer available on the server. Ask an administrator to issue a new key."
      );
    }

    const bundle = buildCodexConfig(
      {
        gatewayBaseUrl: settings.gatewayPublicUrl ?? env().PUBLIC_GATEWAY_URL,
        apiKey: plaintext,
        model: query.model ?? settings.defaultModel,
        wireApi: "chat",
        envKey: DEFAULT_ENV_KEY
      },
      query.mode
    );

    const files: Array<{ name: string; content: string }> = [
      { name: "config.toml", content: bundle.configToml },
      { name: "install.sh", content: bundle.installBash },
      { name: "install.ps1", content: bundle.installPowershell },
      { name: "README.txt", content: readmeFor(bundle.mode) }
    ];
    if (bundle.authJson) files.push({ name: "auth.json", content: bundle.authJson });

    reply.header("content-disposition", 'attachment; filename="codex-gateway-setup.zip"');
    reply.header("cache-control", "no-store");
    return reply.type("application/zip").send(buildStoredZip(files));
  });
}

function readmeFor(mode: string): string {
  return [
    "Codex Gateway — CLI setup",
    "",
    `Mode: ${mode === "openai" ? "override the built-in openai provider" : "dedicated model provider"}`,
    "",
    "Quick install",
    "  macOS / Linux:  bash install.sh",
    "  Windows:        powershell -ExecutionPolicy Bypass -File install.ps1",
    "",
    "Both scripts back up any existing ~/.codex/config.toml (and auth.json)",
    "with a timestamped .bak suffix before writing.",
    "",
    "Manual install",
    "  Copy config.toml (and auth.json, if present) into ~/.codex/",
    "",
    "Keep these files private: they contain your personal gateway API key.",
    ""
  ].join("\n");
}

/* -------------------------------------------------------------------- zip */

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_END_SIG = 0x06054b50;

/** CRC-32 (IEEE 802.3), required in every zip entry header. */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a store-only (compression method 0) zip archive. */
export function buildStoredZip(files: Array<{ name: string; content: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, "utf8");
    const data = Buffer.from(file.content, "utf8");
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP_CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    // Mark the install scripts executable (0755) via the external attributes.
    const unixMode = file.name.endsWith(".sh") ? 0o755 : 0o644;
    central.writeUInt32LE((unixMode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_SIG, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralDirectory, end]);
}

export const SetupSchemas = { CodexSetupQuerySchema, IdParam: z.object({ id: z.string().uuid() }) };
