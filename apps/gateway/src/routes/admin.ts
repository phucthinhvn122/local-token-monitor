import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma, prisma, asNumber } from "@cgw/db";
import {
  CreateApiKeySchema,
  CreateProviderSchema,
  CreateUserSchema,
  LogQuerySchema,
  StatsQuerySchema,
  SystemSettingsSchema,
  TestProviderSchema,
  TopUpSchema,
  UpdateApiKeySchema,
  UpdateProviderSchema,
  UpdateUserSchema,
  UserListQuerySchema,
  type ApiKeyView,
  type ProviderView
} from "@cgw/shared";
import { env } from "../env.js";
import { generateApiKey, maskKey } from "../lib/api-key.js";
import { decryptSecret, encryptSecret, hashPassword, parseEncryptionKey } from "../lib/crypto.js";
import { badRequest, clientIp, conflict, notFound } from "../lib/http.js";
import { recordAudit } from "../lib/audit.js";
import { invalidateSettingsCache, loadSettings } from "../lib/settings.js";
import { usageTimeseries } from "../lib/stats.js";
import { usedPercent } from "../lib/quota.js";
import { probeProvider } from "../lib/upstream.js";
import { rememberPlaintext } from "./me.js";

const IdParam = z.object({ id: z.string().uuid() });

function toApiKeyView(
  key: {
    id: string;
    name: string;
    keyPrefix: string;
    tokenQuota: bigint;
    tokenUsed: bigint;
    status: "ACTIVE" | "REVOKED";
    rateLimitPerMin: number;
    maxConcurrent: number;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    createdAt: Date;
    user?: { id: string; email: string; name: string | null; status: "ACTIVE" | "SUSPENDED" };
  }
): ApiKeyView {
  const tokenQuota = asNumber(key.tokenQuota);
  const tokenUsed = asNumber(key.tokenUsed);
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    maskedKey: maskKey(key.keyPrefix),
    tokenQuota,
    tokenUsed,
    tokenRemaining: Math.max(0, tokenQuota - tokenUsed),
    usedPercent: usedPercent({ tokenQuota, tokenUsed }),
    status: key.status,
    rateLimitPerMin: key.rateLimitPerMin,
    maxConcurrent: key.maxConcurrent,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    createdAt: key.createdAt.toISOString(),
    user: key.user
  };
}

/** The upstream credential never leaves the server; only its last 4 chars do. */
function toProviderView(provider: {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyLast4: string;
  wireApi: "CHAT" | "RESPONSES";
  priority: number;
  weight: number;
  models: string[];
  isActive: boolean;
  timeoutMs: number;
  lastHealthCheck: Date | null;
  lastHealthOk: boolean | null;
  lastHealthLatency: number | null;
  lastErrorAt: Date | null;
  lastErrorMessage: string | null;
  consecutiveErrors: number;
  circuitOpenUntil: Date | null;
}): ProviderView {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKeyMasked: `••••••••${provider.apiKeyLast4}`,
    wireApi: provider.wireApi,
    priority: provider.priority,
    weight: provider.weight,
    models: provider.models,
    isActive: provider.isActive,
    timeoutMs: provider.timeoutMs,
    lastHealthCheck: provider.lastHealthCheck?.toISOString() ?? null,
    lastHealthOk: provider.lastHealthOk,
    lastHealthLatency: provider.lastHealthLatency,
    lastErrorAt: provider.lastErrorAt?.toISOString() ?? null,
    lastErrorMessage: provider.lastErrorMessage,
    consecutiveErrors: provider.consecutiveErrors,
    circuitOpenUntil: provider.circuitOpenUntil?.toISOString() ?? null,
    circuitOpen: Boolean(provider.circuitOpenUntil && provider.circuitOpenUntil.getTime() > Date.now())
  };
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = parseEncryptionKey(env().ENCRYPTION_KEY);

  // Every route in this plugin is admin-only.
  app.addHook("preHandler", async (request) => {
    await app.requireAdmin(request);
  });

  const audit = (request: { authUser?: { id: string }; headers: Record<string, unknown>; ip: string }) => ({
    adminId: request.authUser?.id ?? null,
    ip: clientIp(request.headers, request.ip)
  });

  /* ----------------------------------------------------------------- users */

  app.get("/api/admin/users", async (request) => {
    const query = UserListQuerySchema.parse(request.query);
    const where: Prisma.UserWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.search
        ? {
            OR: [
              { email: { contains: query.search, mode: "insensitive" as const } },
              { name: { contains: query.search, mode: "insensitive" as const } }
            ]
          }
        : {})
    };

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          apiKeys: {
            select: { id: true, tokenQuota: true, tokenUsed: true, status: true }
          }
        }
      })
    ]);

    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      items: users.map((user) => {
        const active = user.apiKeys.filter((key) => key.status === "ACTIVE");
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          status: user.status,
          lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
          createdAt: user.createdAt.toISOString(),
          keyCount: user.apiKeys.length,
          activeKeyCount: active.length,
          tokenQuota: active.reduce((sum, key) => sum + asNumber(key.tokenQuota), 0),
          tokenUsed: active.reduce((sum, key) => sum + asNumber(key.tokenUsed), 0)
        };
      })
    };
  });

  app.post("/api/admin/users", async (request, reply) => {
    const body = CreateUserSchema.parse(request.body);
    const email = body.email.toLowerCase();
    if (await prisma.user.findUnique({ where: { email } })) {
      throw conflict("A user with that email already exists");
    }
    const user = await prisma.user.create({
      data: {
        email,
        name: body.name ?? null,
        role: body.role,
        passwordHash: hashPassword(body.password)
      }
    });
    await recordAudit({ ...audit(request), action: "user.create", targetType: "user", targetId: user.id, metadata: { email } });
    return reply.code(201).send({ id: user.id, email: user.email, name: user.name, role: user.role, status: user.status });
  });

  app.patch("/api/admin/users/:id", async (request) => {
    const { id } = IdParam.parse(request.params);
    const body = UpdateUserSchema.parse(request.body);
    const admin = await app.requireAdmin(request);

    // Guard against an admin locking themselves — and possibly everyone — out.
    if (id === admin.id && (body.role === "USER" || body.status === "SUSPENDED")) {
      throw badRequest("You cannot demote or suspend your own account");
    }
    if (body.role === "USER") {
      const admins = await prisma.user.count({ where: { role: "ADMIN", status: "ACTIVE" } });
      if (admins <= 1) throw badRequest("At least one active administrator must remain");
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.role ? { role: body.role } : {}),
        ...(body.status ? { status: body.status } : {}),
        ...(body.password ? { passwordHash: hashPassword(body.password) } : {})
      }
    });
    if (body.password || body.status === "SUSPENDED") {
      await prisma.session.deleteMany({ where: { userId: id } });
    }
    await recordAudit({
      ...audit(request),
      action: "user.update",
      targetType: "user",
      targetId: id,
      metadata: { fields: Object.keys(body).filter((field) => field !== "password") }
    });
    return { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status };
  });

  app.delete("/api/admin/users/:id", async (request) => {
    const { id } = IdParam.parse(request.params);
    const admin = await app.requireAdmin(request);
    if (id === admin.id) throw badRequest("You cannot delete your own account");

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) throw notFound("User not found");
    if (target.role === "ADMIN") {
      const admins = await prisma.user.count({ where: { role: "ADMIN" } });
      if (admins <= 1) throw badRequest("At least one administrator must remain");
    }

    await prisma.user.delete({ where: { id } });
    await recordAudit({ ...audit(request), action: "user.delete", targetType: "user", targetId: id, metadata: { email: target.email } });
    return { ok: true };
  });

  /* -------------------------------------------------------------- api keys */

  app.get("/api/admin/keys", async (request) => {
    const query = z
      .object({
        userId: z.string().uuid().optional(),
        status: z.enum(["ACTIVE", "REVOKED"]).optional(),
        search: z.string().trim().max(200).optional()
      })
      .parse(request.query);

    const keys = await prisma.apiKey.findMany({
      where: {
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.search
          ? {
              OR: [
                { name: { contains: query.search, mode: "insensitive" as const } },
                { keyPrefix: { contains: query.search, mode: "insensitive" as const } },
                { user: { email: { contains: query.search, mode: "insensitive" as const } } }
              ]
            }
          : {})
      },
      orderBy: { createdAt: "desc" },
      include: { user: { select: { id: true, email: true, name: true, status: true } } }
    });

    return { items: keys.map(toApiKeyView) };
  });

  /**
   * Create a key, optionally creating its user in the same transaction.
   * The plaintext is returned exactly once here and is never recoverable
   * afterwards — only its SHA-256 digest is stored.
   */
  app.post("/api/admin/keys", async (request, reply) => {
    const body = CreateApiKeySchema.parse(request.body);
    const admin = await app.requireAdmin(request);
    const generated = generateApiKey();

    const created = await prisma.$transaction(async (tx) => {
      let userId = body.userId;

      if (body.newUser) {
        const email = body.newUser.email.toLowerCase();
        if (await tx.user.findUnique({ where: { email } })) {
          throw conflict("A user with that email already exists");
        }
        const user = await tx.user.create({
          data: {
            email,
            name: body.newUser.name ?? null,
            role: body.newUser.role,
            passwordHash: hashPassword(body.newUser.password)
          }
        });
        userId = user.id;
      } else if (!(await tx.user.findUnique({ where: { id: userId! } }))) {
        throw notFound("User not found");
      }

      const key = await tx.apiKey.create({
        data: {
          userId: userId!,
          name: body.name,
          keyHash: generated.keyHash,
          keyEncrypted: env().STRICT_ONE_TIME_KEYS
            ? null
            : encryptSecret(generated.plaintext, encryptionKey),
          keyPrefix: generated.keyPrefix,
          tokenQuota: BigInt(body.tokenQuota),
          rateLimitPerMin: body.rateLimitPerMin,
          maxConcurrent: body.maxConcurrent,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          createdByAdminId: admin.id
        },
        include: { user: { select: { id: true, email: true, name: true, status: true } } }
      });

      // The opening GRANT makes the balance reconstructable from day one.
      if (body.tokenQuota > 0) {
        await tx.tokenTransaction.create({
          data: {
            apiKeyId: key.id,
            adminId: admin.id,
            amount: BigInt(body.tokenQuota),
            type: "GRANT",
            note: body.note ?? "Initial grant"
          }
        });
      }

      return key;
    });

    await recordAudit({
      ...audit(request),
      action: "apikey.create",
      targetType: "api_key",
      targetId: created.id,
      metadata: { userId: created.userId, tokenQuota: body.tokenQuota, keyPrefix: created.keyPrefix }
    });

    // Keep the plaintext reachable for this process even in strict mode, so the
    // user can complete Codex setup right after the key is handed to them.
    rememberPlaintext(created.id, generated.plaintext);

    return reply.code(201).send({
      key: toApiKeyView(created),
      /** Displayed once by the UI; no read endpoint ever returns it again. */
      plaintext: generated.plaintext
    });
  });

  /** Rotate a key in place: same row, same quota and usage, brand new secret. */
  app.post("/api/admin/keys/:id/rotate", async (request) => {
    const { id } = IdParam.parse(request.params);
    const generated = generateApiKey();

    const key = await prisma.apiKey.update({
      where: { id },
      data: {
        keyHash: generated.keyHash,
        keyEncrypted: env().STRICT_ONE_TIME_KEYS
          ? null
          : encryptSecret(generated.plaintext, encryptionKey),
        keyPrefix: generated.keyPrefix,
        status: "ACTIVE"
      },
      include: { user: { select: { id: true, email: true, name: true, status: true } } }
    });
    rememberPlaintext(id, generated.plaintext);

    await recordAudit({
      ...audit(request),
      action: "apikey.update",
      targetType: "api_key",
      targetId: id,
      metadata: { rotated: true, keyPrefix: generated.keyPrefix }
    });
    return { key: toApiKeyView(key), plaintext: generated.plaintext };
  });

  app.get("/api/admin/keys/:id", async (request) => {
    const { id } = IdParam.parse(request.params);
    const key = await prisma.apiKey.findUnique({
      where: { id },
      include: { user: { select: { id: true, email: true, name: true, status: true } } }
    });
    if (!key) throw notFound("API key not found");

    const [transactions, timeseries, totals] = await Promise.all([
      prisma.tokenTransaction.findMany({
        where: { apiKeyId: id },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { admin: { select: { email: true } } }
      }),
      usageTimeseries({ range: "30d", apiKeyId: id }),
      prisma.usageLog.aggregate({
        where: { apiKeyId: id },
        _count: { _all: true },
        _avg: { latencyMs: true }
      })
    ]);

    return {
      key: toApiKeyView(key),
      timeseries,
      requestCount: totals._count._all,
      avgLatencyMs: Math.round(totals._avg.latencyMs ?? 0),
      transactions: transactions.map((item) => ({
        id: item.id,
        amount: asNumber(item.amount),
        type: item.type,
        note: item.note,
        adminEmail: item.admin?.email ?? null,
        createdAt: item.createdAt.toISOString()
      }))
    };
  });

  app.post("/api/admin/keys/:id/topup", async (request) => {
    const { id } = IdParam.parse(request.params);
    const body = TopUpSchema.parse(request.body);
    const admin = await app.requireAdmin(request);

    const [key] = await prisma.$transaction([
      prisma.apiKey.update({
        where: { id },
        data: { tokenQuota: { increment: BigInt(body.amount) } },
        include: { user: { select: { id: true, email: true, name: true, status: true } } }
      }),
      prisma.tokenTransaction.create({
        data: {
          apiKeyId: id,
          adminId: admin.id,
          amount: BigInt(body.amount),
          type: "TOPUP",
          note: body.note ?? null
        }
      })
    ]);

    await recordAudit({
      ...audit(request),
      action: "apikey.topup",
      targetType: "api_key",
      targetId: id,
      metadata: { amount: body.amount }
    });
    return { key: toApiKeyView(key) };
  });

  app.patch("/api/admin/keys/:id", async (request) => {
    const { id } = IdParam.parse(request.params);
    const body = UpdateApiKeySchema.parse(request.body);

    const key = await prisma.apiKey.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.status ? { status: body.status } : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt ? new Date(body.expiresAt) : null } : {}),
        ...(body.rateLimitPerMin !== undefined ? { rateLimitPerMin: body.rateLimitPerMin } : {}),
        ...(body.maxConcurrent !== undefined ? { maxConcurrent: body.maxConcurrent } : {})
      },
      include: { user: { select: { id: true, email: true, name: true, status: true } } }
    });

    await recordAudit({
      ...audit(request),
      action: body.status === "REVOKED" ? "apikey.revoke" : "apikey.update",
      targetType: "api_key",
      targetId: id,
      metadata: body as Record<string, unknown>
    });
    return { key: toApiKeyView(key) };
  });

  app.delete("/api/admin/keys/:id", async (request) => {
    const { id } = IdParam.parse(request.params);
    await prisma.apiKey.delete({ where: { id } });
    await recordAudit({ ...audit(request), action: "apikey.delete", targetType: "api_key", targetId: id });
    return { ok: true };
  });

  /* ------------------------------------------------------------- providers */

  app.get("/api/admin/providers", async () => {
    const providers = await prisma.poolProvider.findMany({ orderBy: [{ priority: "asc" }, { name: "asc" }] });
    const since = new Date(Date.now() - 24 * 3_600_000);

    const stats = await prisma.usageLog.groupBy({
      by: ["providerId"],
      where: { createdAt: { gte: since }, providerId: { not: null } },
      _count: { _all: true },
      _sum: { totalTokens: true },
      _avg: { latencyMs: true }
    });
    const errors = await prisma.usageLog.groupBy({
      by: ["providerId"],
      where: { createdAt: { gte: since }, providerId: { not: null }, statusCode: { gte: 400 } },
      _count: { _all: true }
    });

    const statById = new Map(stats.map((row) => [row.providerId, row]));
    const errorById = new Map(errors.map((row) => [row.providerId, row._count._all]));

    return {
      items: providers.map((provider) => {
        const stat = statById.get(provider.id);
        const requests = stat?._count._all ?? 0;
        const errorCount = errorById.get(provider.id) ?? 0;
        return {
          ...toProviderView(provider),
          stats: {
            requests,
            errors: errorCount,
            errorRate: requests > 0 ? Math.round((errorCount / requests) * 1000) / 10 : 0,
            totalTokens: stat?._sum.totalTokens ?? 0,
            avgLatencyMs: Math.round(stat?._avg.latencyMs ?? 0)
          }
        };
      })
    };
  });

  app.post("/api/admin/providers", async (request, reply) => {
    const body = CreateProviderSchema.parse(request.body);
    if (await prisma.poolProvider.findUnique({ where: { name: body.name } })) {
      throw conflict("A provider with that name already exists");
    }
    const provider = await prisma.poolProvider.create({
      data: {
        name: body.name,
        baseUrl: body.baseUrl.replace(/\/+$/, ""),
        apiKeyEncrypted: encryptSecret(body.apiKey, encryptionKey),
        apiKeyLast4: body.apiKey.slice(-4),
        wireApi: body.wireApi,
        priority: body.priority,
        weight: body.weight,
        models: body.models,
        isActive: body.isActive,
        timeoutMs: body.timeoutMs
      }
    });
    await recordAudit({
      ...audit(request),
      action: "provider.create",
      targetType: "pool_provider",
      targetId: provider.id,
      metadata: { name: body.name, baseUrl: body.baseUrl, wireApi: body.wireApi }
    });
    return reply.code(201).send({ provider: toProviderView(provider) });
  });

  app.patch("/api/admin/providers/:id", async (request) => {
    const { id } = IdParam.parse(request.params);
    const body = UpdateProviderSchema.parse(request.body);

    const provider = await prisma.poolProvider.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.baseUrl ? { baseUrl: body.baseUrl.replace(/\/+$/, "") } : {}),
        ...(body.apiKey
          ? { apiKeyEncrypted: encryptSecret(body.apiKey, encryptionKey), apiKeyLast4: body.apiKey.slice(-4) }
          : {}),
        ...(body.wireApi ? { wireApi: body.wireApi } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.weight !== undefined ? { weight: body.weight } : {}),
        ...(body.models !== undefined ? { models: body.models } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
        // Re-enabling or re-pointing a provider is an explicit vote of
        // confidence: clear the breaker so it is tried again immediately.
        ...(body.isActive === true || body.baseUrl || body.apiKey
          ? { consecutiveErrors: 0, circuitOpenUntil: null }
          : {})
      }
    });

    await recordAudit({
      ...audit(request),
      action: "provider.update",
      targetType: "pool_provider",
      targetId: id,
      metadata: { fields: Object.keys(body).filter((field) => field !== "apiKey") }
    });
    return { provider: toProviderView(provider) };
  });

  app.delete("/api/admin/providers/:id", async (request) => {
    const { id } = IdParam.parse(request.params);
    await prisma.poolProvider.delete({ where: { id } });
    await recordAudit({ ...audit(request), action: "provider.delete", targetType: "pool_provider", targetId: id });
    return { ok: true };
  });

  /** Test a saved provider, or an unsaved form when credentials are supplied. */
  app.post("/api/admin/providers/:id/test", async (request) => {
    const { id } = IdParam.parse(request.params);
    const body = TestProviderSchema.parse(request.body ?? {});

    let baseUrl = body.baseUrl;
    let apiKey = body.apiKey;

    if (id !== "00000000-0000-0000-0000-000000000000") {
      const provider = await prisma.poolProvider.findUnique({ where: { id } });
      if (!provider) throw notFound("Provider not found");
      baseUrl ??= provider.baseUrl;
      apiKey ??= decryptSecret(provider.apiKeyEncrypted, encryptionKey);
    }
    if (!baseUrl || !apiKey) throw badRequest("Base URL and API key are required to test a connection");

    const result = await probeProvider({ baseUrl, apiKey });

    if (id !== "00000000-0000-0000-0000-000000000000") {
      await prisma.poolProvider.update({
        where: { id },
        data: {
          lastHealthCheck: new Date(),
          lastHealthOk: result.ok,
          lastHealthLatency: result.latencyMs,
          ...(result.ok
            ? { consecutiveErrors: 0, circuitOpenUntil: null }
            : { lastErrorAt: new Date(), lastErrorMessage: result.message.slice(0, 500) })
        }
      });
    }

    await recordAudit({
      ...audit(request),
      action: "provider.test",
      targetType: "pool_provider",
      targetId: id,
      metadata: { ok: result.ok, statusCode: result.statusCode }
    });
    return result;
  });

  /* ----------------------------------------------------------- dashboard */

  app.get("/api/admin/overview", async (request) => {
    const query = StatsQuerySchema.parse(request.query);
    const settings = await loadSettings();

    const [userCount, activeUsers, keyAggregate, activeKeys, providers, timeseries, topRows] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { status: "ACTIVE" } }),
      prisma.apiKey.aggregate({ _sum: { tokenQuota: true, tokenUsed: true }, _count: { _all: true } }),
      prisma.apiKey.count({ where: { status: "ACTIVE" } }),
      prisma.poolProvider.findMany({ orderBy: [{ priority: "asc" }] }),
      usageTimeseries({ range: query.range, bucket: query.bucket }),
      prisma.usageLog.groupBy({
        by: ["apiKeyId"],
        where: { createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) }, apiKeyId: { not: null } },
        _sum: { totalTokens: true },
        _count: { _all: true },
        orderBy: { _sum: { totalTokens: "desc" } },
        take: 10
      })
    ]);

    const topKeys = await prisma.apiKey.findMany({
      where: { id: { in: topRows.map((row) => row.apiKeyId!).filter(Boolean) } },
      include: { user: { select: { email: true, name: true } } }
    });
    const keyById = new Map(topKeys.map((key) => [key.id, key]));

    const requestsInRange = timeseries.reduce((sum, point) => sum + point.requests, 0);
    const errorsInRange = timeseries.reduce((sum, point) => sum + point.errors, 0);

    return {
      totals: {
        users: userCount,
        activeUsers,
        apiKeys: keyAggregate._count._all,
        activeApiKeys: activeKeys,
        tokensGranted: asNumber(keyAggregate._sum.tokenQuota),
        tokensUsed: asNumber(keyAggregate._sum.tokenUsed),
        requestsInRange,
        errorsInRange,
        errorRate: requestsInRange > 0 ? Math.round((errorsInRange / requestsInRange) * 1000) / 10 : 0
      },
      timeseries,
      providers: providers.map(toProviderView),
      routingStrategy: settings.routingStrategy,
      topUsers: topRows.map((row) => {
        const key = keyById.get(row.apiKeyId!);
        return {
          apiKeyId: row.apiKeyId,
          email: key?.user.email ?? "unknown",
          name: key?.user.name ?? null,
          keyPrefix: key?.keyPrefix ?? null,
          totalTokens: row._sum.totalTokens ?? 0,
          requests: row._count._all
        };
      })
    };
  });

  /* ---------------------------------------------------------------- logs */

  const buildLogWhere = (query: z.infer<typeof LogQuerySchema>): Prisma.UsageLogWhereInput => ({
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {})
          }
        }
      : {}),
    ...(query.apiKeyId ? { apiKeyId: query.apiKeyId } : {}),
    ...(query.providerId ? { providerId: query.providerId } : {}),
    ...(query.model ? { model: { contains: query.model, mode: "insensitive" as const } } : {}),
    ...(query.sessionId ? { sessionId: query.sessionId } : {}),
    ...(query.userId ? { apiKey: { userId: query.userId } } : {}),
    ...(query.status === "error"
      ? { OR: [{ statusCode: { gte: 400 } }, { statusCode: 0 }] }
      : query.status === "success"
        ? { statusCode: { gte: 200, lt: 400 } }
        : {})
  });

  app.get("/api/admin/logs", async (request) => {
    const query = LogQuerySchema.parse(request.query);
    const where = buildLogWhere(query);

    const [total, logs] = await Promise.all([
      prisma.usageLog.count({ where }),
      prisma.usageLog.findMany({
        where,
        orderBy: { [query.sort]: query.order } as Prisma.UsageLogOrderByWithRelationInput,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          provider: { select: { name: true } },
          apiKey: { select: { keyPrefix: true, user: { select: { email: true } } } }
        }
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
        errorMessage: log.errorMessage,
        providerName: log.provider?.name ?? null,
        userEmail: log.apiKey?.user.email ?? null,
        keyPrefix: log.apiKey?.keyPrefix ?? null
      }))
    };
  });

  app.get("/api/admin/logs/export", async (request, reply) => {
    const query = LogQuerySchema.parse({ ...(request.query as object), page: 1, pageSize: 1 });
    const logs = await prisma.usageLog.findMany({
      where: buildLogWhere(query),
      orderBy: { createdAt: "desc" },
      // Bounded so a wide filter cannot pull the whole table into memory.
      take: 50_000,
      include: {
        provider: { select: { name: true } },
        apiKey: { select: { keyPrefix: true, user: { select: { email: true } } } }
      }
    });

    const headers = [
      "created_at", "user_email", "key_prefix", "provider", "model", "endpoint", "session_id",
      "streamed", "input_tokens", "output_tokens", "cached_tokens", "total_tokens", "accuracy",
      "latency_ms", "status_code", "error"
    ];
    const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = logs.map((log) =>
      [
        log.createdAt.toISOString(), log.apiKey?.user.email, log.apiKey?.keyPrefix, log.provider?.name,
        log.model, log.endpoint, log.sessionId, log.streamed, log.inputTokens, log.outputTokens,
        log.cachedTokens, log.totalTokens, log.accuracy, log.latencyMs, log.statusCode, log.errorMessage
      ]
        .map(escape)
        .join(",")
    );

    reply.header("content-disposition", `attachment; filename="gateway-usage-logs.csv"`);
    return reply.type("text/csv").send([headers.join(","), ...rows].join("\n"));
  });

  app.get("/api/admin/audit", async (request) => {
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
        action: z.string().trim().max(60).optional()
      })
      .parse(request.query);

    const where = query.action ? { action: query.action } : {};
    const [total, logs] = await Promise.all([
      prisma.adminAuditLog.count({ where }),
      prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { admin: { select: { email: true } } }
      })
    ]);

    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      items: logs.map((log) => ({
        id: log.id,
        action: log.action,
        targetType: log.targetType,
        targetId: log.targetId,
        metadata: log.metadata,
        ip: log.ip,
        adminEmail: log.admin?.email ?? null,
        createdAt: log.createdAt.toISOString()
      }))
    };
  });

  /* ------------------------------------------------------------ settings */

  app.get("/api/admin/settings", async () => {
    const settings = await loadSettings(true);
    return { settings: { ...settings, gatewayPublicUrl: settings.gatewayPublicUrl ?? env().PUBLIC_GATEWAY_URL } };
  });

  app.patch("/api/admin/settings", async (request) => {
    const body = SystemSettingsSchema.parse(request.body);
    const settings = await prisma.systemSetting.upsert({
      where: { id: 1 },
      update: body,
      create: { id: 1, ...body }
    });
    invalidateSettingsCache();
    await recordAudit({
      ...audit(request),
      action: "settings.update",
      targetType: "system",
      targetId: "1",
      metadata: body as Record<string, unknown>
    });
    return { settings };
  });
}
