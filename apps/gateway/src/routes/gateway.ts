import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma, asNumber, type PoolProvider } from "@cgw/db";
import { safeError } from "@cgw/core";
import { GATEWAY_ERROR_CODES } from "@cgw/shared";
import { calculateCost, estimateRequestTokens, estimateTokens } from "@cgw/token-estimator";
import { env } from "../env.js";
import { hashApiKey, parseBearer } from "../lib/api-key.js";
import { parseEncryptionKey } from "../lib/crypto.js";
import { forwardableResponseHeaders, sendOpenAiError } from "../lib/http.js";
import { acquireSlot, checkRateLimit, releaseSlot } from "../lib/rate-limit.js";
import { chargeTokens, hasQuota } from "../lib/quota.js";
import { isProviderFailure, nextBreakerState, orderProviders, type RoutableProvider } from "../lib/router.js";
import { loadPricing, loadSettings } from "../lib/settings.js";
import { callUpstream } from "../lib/upstream.js";
import {
  EMPTY_USAGE,
  inspectSseEvent,
  parseSseEvents,
  usageFromBody,
  withUsageReporting,
  type NormalizedUsage
} from "../lib/usage.js";

interface AuthenticatedKey {
  id: string;
  userId: string;
  keyPrefix: string;
  tokenQuota: number;
  tokenUsed: number;
  rateLimitPerMin: number;
  maxConcurrent: number;
}

interface PendingLog {
  apiKeyId: string;
  providerId: string | null;
  model: string | null;
  sessionId: string | null;
  endpoint: string;
  streamed: boolean;
  usage: NormalizedUsage;
  accuracy: "exact" | "estimated";
  latencyMs: number;
  statusCode: number;
  errorMessage: string | null;
}

/**
 * Persist the usage log and charge the key.
 *
 * Deliberately fire-and-forget from the request's point of view: the client
 * already has its bytes, and a database hiccup must not turn a successful
 * completion into an error. Failures are logged, never swallowed silently.
 */
async function settleRequest(app: FastifyInstance, log: PendingLog, pricingModel: string | null): Promise<void> {
  try {
    const pricing = await loadPricing();
    const estimatedCost = calculateCost(
      { inputTokens: log.usage.inputTokens, outputTokens: log.usage.outputTokens, cachedTokens: log.usage.cachedTokens },
      pricingModel,
      pricing
    );

    await prisma.usageLog.create({
      data: {
        apiKeyId: log.apiKeyId,
        providerId: log.providerId,
        model: log.model,
        sessionId: log.sessionId,
        endpoint: log.endpoint,
        streamed: log.streamed,
        inputTokens: log.usage.inputTokens,
        outputTokens: log.usage.outputTokens,
        cachedTokens: log.usage.cachedTokens,
        totalTokens: log.usage.totalTokens,
        accuracy: log.accuracy,
        estimatedCost: estimatedCost ?? null,
        latencyMs: log.latencyMs,
        statusCode: log.statusCode,
        errorMessage: log.errorMessage
      }
    });

    if (log.usage.totalTokens > 0) {
      await chargeTokens(log.apiKeyId, log.usage.totalTokens, `${log.endpoint}${log.model ? ` · ${log.model}` : ""}`);
    }
  } catch (error) {
    app.log.error({ error: safeError(error) }, "Failed to settle gateway request");
  }
}

async function markProviderSuccess(providerId: string, latencyMs: number): Promise<void> {
  await prisma.poolProvider.update({
    where: { id: providerId },
    data: {
      consecutiveErrors: 0,
      circuitOpenUntil: null,
      lastHealthCheck: new Date(),
      lastHealthOk: true,
      lastHealthLatency: latencyMs
    }
  });
}

async function markProviderFailure(
  app: FastifyInstance,
  provider: PoolProvider,
  message: string,
  threshold: number,
  cooldownSeconds: number
): Promise<void> {
  const next = nextBreakerState(provider.consecutiveErrors, { threshold, cooldownSeconds });
  await prisma.poolProvider.update({
    where: { id: provider.id },
    data: {
      consecutiveErrors: next.consecutiveErrors,
      circuitOpenUntil: next.circuitOpenUntil,
      lastErrorAt: new Date(),
      lastErrorMessage: message.slice(0, 500),
      lastHealthOk: false
    }
  });
  if (next.opened) {
    app.log.warn(
      { provider: provider.name, errors: next.consecutiveErrors, until: next.circuitOpenUntil },
      "Circuit opened for pool provider"
    );
  }
}

function toRoutable(provider: PoolProvider): RoutableProvider {
  return {
    id: provider.id,
    name: provider.name,
    priority: provider.priority,
    weight: provider.weight,
    models: provider.models,
    isActive: provider.isActive,
    consecutiveErrors: provider.consecutiveErrors,
    circuitOpenUntil: provider.circuitOpenUntil
  };
}

/** Codex sends a stable conversation id; use it to group a working session. */
function sessionIdFrom(request: FastifyRequest, body: Record<string, unknown>): string | null {
  const header =
    request.headers["x-session-id"] ??
    request.headers["session_id"] ??
    request.headers["conversation_id"];
  if (typeof header === "string" && header.length > 0) return header.slice(0, 200);
  for (const field of ["session_id", "conversation_id", "previous_response_id", "user"]) {
    const value = body[field];
    if (typeof value === "string" && value.length > 0) return value.slice(0, 200);
  }
  return null;
}

async function authenticateKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AuthenticatedKey | null> {
  const token = parseBearer(request.headers.authorization);
  if (!token) {
    sendOpenAiError(reply, 401, "Missing Authorization header", GATEWAY_ERROR_CODES.invalidApiKey, "authentication_error");
    return null;
  }

  const record = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(token) },
    include: { user: { select: { status: true } } }
  });

  if (!record) {
    sendOpenAiError(reply, 401, "Invalid API key", GATEWAY_ERROR_CODES.invalidApiKey, "authentication_error");
    return null;
  }
  if (record.status === "REVOKED") {
    sendOpenAiError(reply, 403, "This API key has been revoked", GATEWAY_ERROR_CODES.keyRevoked, "authentication_error");
    return null;
  }
  if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
    sendOpenAiError(reply, 403, "This API key has expired", GATEWAY_ERROR_CODES.keyExpired, "authentication_error");
    return null;
  }
  if (record.user.status !== "ACTIVE") {
    sendOpenAiError(reply, 403, "This account is suspended", GATEWAY_ERROR_CODES.userSuspended, "authentication_error");
    return null;
  }

  return {
    id: record.id,
    userId: record.userId,
    keyPrefix: record.keyPrefix,
    tokenQuota: asNumber(record.tokenQuota),
    tokenUsed: asNumber(record.tokenUsed),
    rateLimitPerMin: record.rateLimitPerMin,
    maxConcurrent: record.maxConcurrent
  };
}

export async function gatewayRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = parseEncryptionKey(env().ENCRYPTION_KEY);

  /**
   * Advertise the union of models the pool can serve. Providers with an empty
   * allow-list accept anything, so the configured default model is always
   * listed to keep clients that validate the list working.
   */
  app.get("/v1/models", async (request, reply) => {
    const key = await authenticateKey(request, reply);
    if (!key) return reply;

    const [providers, settings] = await Promise.all([
      prisma.poolProvider.findMany({ where: { isActive: true }, select: { models: true } }),
      loadSettings()
    ]);

    const ids = new Set<string>([settings.defaultModel]);
    for (const provider of providers) for (const model of provider.models) ids.add(model);

    return reply.send({
      object: "list",
      data: [...ids].sort().map((id) => ({ id, object: "model", owned_by: "codex-gateway", created: 0 }))
    });
  });

  const handleProxy = (endpoint: "/v1/chat/completions" | "/v1/responses") =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const key = await authenticateKey(request, reply);
      if (!key) return reply;

      const settings = await loadSettings();
      const rateLimit = key.rateLimitPerMin || settings.defaultRateLimitPerMin;
      const maxConcurrent = key.maxConcurrent || settings.defaultMaxConcurrent;

      const limit = checkRateLimit(key.id, rateLimit);
      if (!limit.allowed) {
        reply.header("retry-after", String(limit.retryAfterSeconds ?? 1));
        return sendOpenAiError(
          reply,
          429,
          `Rate limit of ${rateLimit} requests/minute exceeded`,
          GATEWAY_ERROR_CODES.rateLimited,
          "rate_limit_error"
        );
      }

      if (!hasQuota({ tokenQuota: key.tokenQuota, tokenUsed: key.tokenUsed })) {
        return sendOpenAiError(
          reply,
          402,
          "Token quota exhausted. Ask an administrator to top up this key.",
          GATEWAY_ERROR_CODES.quotaExhausted,
          "insufficient_quota"
        );
      }

      if (!acquireSlot(key.id, maxConcurrent)) {
        return sendOpenAiError(
          reply,
          429,
          `At most ${maxConcurrent} concurrent requests are allowed for this key`,
          GATEWAY_ERROR_CODES.tooManyConcurrent,
          "rate_limit_error"
        );
      }

      try {
        return await forwardRequest({ app, request, reply, endpoint, key, settings, encryptionKey });
      } finally {
        releaseSlot(key.id);
      }
    };

  app.post("/v1/chat/completions", handleProxy("/v1/chat/completions"));
  app.post("/v1/responses", handleProxy("/v1/responses"));
}

async function forwardRequest(context: {
  app: FastifyInstance;
  request: FastifyRequest;
  reply: FastifyReply;
  endpoint: "/v1/chat/completions" | "/v1/responses";
  key: AuthenticatedKey;
  settings: Awaited<ReturnType<typeof loadSettings>>;
  encryptionKey: Buffer;
}): Promise<FastifyReply> {
  const { app, request, reply, endpoint, key, settings, encryptionKey } = context;

  const body = (request.body ?? {}) as Record<string, unknown>;
  const model = typeof body.model === "string" ? body.model : settings.defaultModel;
  const wantsStream = body.stream === true;
  const sessionId = sessionIdFrom(request, body);

  const providers = await prisma.poolProvider.findMany({ where: { isActive: true } });
  const ordered = orderProviders(providers.map(toRoutable), {
    strategy: settings.routingStrategy,
    model
  });

  if (ordered.length === 0) {
    await settleRequest(
      app,
      {
        apiKeyId: key.id,
        providerId: null,
        model,
        sessionId,
        endpoint,
        streamed: wantsStream,
        usage: EMPTY_USAGE,
        accuracy: "exact",
        latencyMs: 0,
        statusCode: 503,
        errorMessage: "No pool provider available"
      },
      model
    );
    return sendOpenAiError(
      reply,
      503,
      "No upstream provider is currently available",
      GATEWAY_ERROR_CODES.noProvider,
      "api_error"
    );
  }

  // Chat Completions only reports usage on a stream when explicitly asked. The
  // gateway always asks, then hides the extra chunk if the client did not.
  const isChat = endpoint === "/v1/chat/completions";
  const prepared = wantsStream && isChat ? withUsageReporting(body) : { body, clientRequestedUsage: true };
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));

  let lastError = "No upstream provider is currently available";
  let lastStatus = 503;

  for (const candidate of ordered) {
    const provider = providerById.get(candidate.id);
    if (!provider) continue;

    const result = await callUpstream({
      target: {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKeyEncrypted: provider.apiKeyEncrypted,
        timeoutMs: provider.timeoutMs
      },
      path: endpoint,
      body: prepared.body,
      clientHeaders: request.headers as Record<string, unknown>,
      encryptionKey
    });

    // A provider-level failure is retried against the next pool member. A 4xx
    // that is the client's fault is returned as-is: retrying it elsewhere would
    // just multiply the same rejection.
    if (!result.response || isProviderFailure(result.statusCode)) {
      lastError = result.error ?? "Upstream request failed";
      lastStatus = result.statusCode ?? 502;
      await markProviderFailure(
        app,
        provider,
        lastError,
        settings.circuitThreshold,
        settings.circuitCooldownSeconds
      );
      app.log.warn({ provider: provider.name, status: result.statusCode }, "Pool provider failed, trying next");
      continue;
    }

    await markProviderSuccess(provider.id, result.latencyMs);

    return wantsStream
      ? streamResponse({ ...context, provider, result, model, sessionId, prepared })
      : bufferResponse({ ...context, provider, result, model, sessionId });
  }

  // Every provider failed.
  await settleRequest(
    app,
    {
      apiKeyId: key.id,
      providerId: null,
      model,
      sessionId,
      endpoint,
      streamed: wantsStream,
      usage: EMPTY_USAGE,
      accuracy: "exact",
      latencyMs: 0,
      statusCode: lastStatus,
      errorMessage: lastError
    },
    model
  );

  return sendOpenAiError(
    reply,
    502,
    `All upstream providers failed. Last error: ${lastError}`,
    GATEWAY_ERROR_CODES.upstreamError,
    "api_error"
  );
}

async function bufferResponse(context: {
  app: FastifyInstance;
  reply: FastifyReply;
  endpoint: string;
  key: AuthenticatedKey;
  provider: PoolProvider;
  result: { response: Response | null; statusCode: number | null; latencyMs: number };
  model: string;
  sessionId: string | null;
  request: FastifyRequest;
}): Promise<FastifyReply> {
  const { app, reply, endpoint, key, provider, result, model, sessionId, request } = context;
  const response = result.response!;
  const text = await response.text();

  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  let usage = usageFromBody(payload);
  let accuracy: "exact" | "estimated" = "exact";

  // Fall back to a local estimate only when the provider reported nothing.
  if (!usage && response.ok) {
    const input = estimateRequestTokens(request.body, model);
    const output = estimateTokens(text, model);
    usage = {
      inputTokens: input.tokens,
      outputTokens: output.tokens,
      cachedTokens: 0,
      totalTokens: input.tokens + output.tokens
    };
    accuracy = "estimated";
  }

  void settleRequest(
    app,
    {
      apiKeyId: key.id,
      providerId: provider.id,
      model,
      sessionId,
      endpoint,
      streamed: false,
      usage: usage ?? EMPTY_USAGE,
      accuracy,
      latencyMs: result.latencyMs,
      statusCode: response.status,
      errorMessage: response.ok ? null : `Upstream responded ${response.status}`
    },
    model
  );

  for (const [name, value] of Object.entries(forwardableResponseHeaders(response.headers))) {
    reply.header(name, value);
  }
  return reply.code(response.status).send(text);
}

async function streamResponse(context: {
  app: FastifyInstance;
  reply: FastifyReply;
  endpoint: string;
  key: AuthenticatedKey;
  provider: PoolProvider;
  result: { response: Response | null; statusCode: number | null; latencyMs: number };
  model: string;
  sessionId: string | null;
  prepared: { clientRequestedUsage: boolean };
  request: FastifyRequest;
}): Promise<FastifyReply> {
  const { app, reply, endpoint, key, provider, result, model, sessionId, prepared, request } = context;
  const response = result.response!;
  const startedAt = Date.now();

  // Take over the socket: SSE has to reach the client unbuffered, chunk by
  // chunk, and any framework-level buffering would defeat that.
  reply.hijack();
  reply.raw.writeHead(response.status, {
    ...forwardableResponseHeaders(response.headers),
    "content-type": response.headers.get("content-type") ?? "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });

  let usage: NormalizedUsage | null = null;
  let accuracy: "exact" | "estimated" = "exact";
  let outputText = "";
  let buffer = "";
  let aborted = false;

  const finish = (statusCode: number, errorMessage: string | null) => {
    if (!usage) {
      // No provider usage anywhere in the stream: estimate from what we saw.
      const input = estimateRequestTokens(request.body, model);
      const output = estimateTokens(outputText, model);
      usage = {
        inputTokens: input.tokens,
        outputTokens: output.tokens,
        cachedTokens: 0,
        totalTokens: input.tokens + output.tokens
      };
      accuracy = "estimated";
    }
    void settleRequest(
      app,
      {
        apiKeyId: key.id,
        providerId: provider.id,
        model,
        sessionId,
        endpoint,
        streamed: true,
        usage,
        accuracy,
        latencyMs: Date.now() - startedAt,
        statusCode,
        errorMessage
      },
      model
    );
  };

  // If the client hangs up mid-stream, stop pulling from the upstream and still
  // bill for what was already generated.
  request.raw.on("close", () => {
    aborted = true;
  });

  if (!response.body) {
    reply.raw.end();
    finish(response.status, "Upstream returned an empty body");
    return reply;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (aborted) {
        await reader.cancel().catch(() => undefined);
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseEvents(buffer);
      buffer = rest;

      for (const event of events) {
        const inspected = inspectSseEvent(event);
        if (inspected.usage) usage = inspected.usage;
        if (inspected.outputText) outputText += inspected.outputText;

        // Drop the usage-only chunk the gateway asked for on the client's behalf.
        if (inspected.usageOnly && !prepared.clientRequestedUsage) continue;
        reply.raw.write(event.raw);
      }
    }

    // Flush whatever did not end with a blank line (some providers omit the
    // final separator before closing the connection).
    if (buffer.length > 0 && !aborted) reply.raw.write(buffer);
    reply.raw.end();
    finish(response.status, null);
  } catch (error) {
    const message = safeError(error);
    app.log.warn({ provider: provider.name, error: message }, "Streaming from pool provider failed mid-flight");
    if (!reply.raw.writableEnded) {
      // Bytes are already on the wire, so failover is no longer possible; the
      // best we can do is signal the break inside the stream itself.
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: { message, type: "api_error" } })}\n\n`);
      reply.raw.end();
    }
    finish(response.status, message);
  }

  return reply;
}
