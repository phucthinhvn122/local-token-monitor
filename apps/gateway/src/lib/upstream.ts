import { safeError } from "@cgw/core";
import { decryptSecret } from "./crypto.js";
import { forwardableRequestHeaders } from "./http.js";

export interface UpstreamTarget {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEncrypted: string;
  timeoutMs: number;
}

export interface UpstreamCallResult {
  response: Response | null;
  /** null when the request never produced an HTTP response (timeout, DNS, TLS). */
  statusCode: number | null;
  error: string | null;
  latencyMs: number;
}

/** Join a provider base URL with a path, tolerating a trailing slash or `/v1`. */
export function resolveUpstreamUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  // `/v1/chat/completions` against a base already ending in `/v1` must not
  // become `/v1/v1/chat/completions`.
  if (base.endsWith("/v1") && suffix.startsWith("/v1/")) return `${base}${suffix.slice(3)}`;
  return `${base}${suffix}`;
}

/**
 * Forward one request to one pool provider.
 *
 * Never throws: transport failures are returned as `statusCode: null` so the
 * caller's failover loop treats them uniformly with 5xx responses. The upstream
 * credential is decrypted here, used for exactly this call, and never returned.
 */
export async function callUpstream(options: {
  target: UpstreamTarget;
  path: string;
  body: unknown;
  clientHeaders: Record<string, unknown>;
  encryptionKey: Buffer;
  signal?: AbortSignal;
}): Promise<UpstreamCallResult> {
  const startedAt = Date.now();
  const url = resolveUpstreamUrl(options.target.baseUrl, options.path);

  const timeout = AbortSignal.timeout(options.target.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  try {
    const apiKey = decryptSecret(options.target.apiKeyEncrypted, options.encryptionKey);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...forwardableRequestHeaders(options.clientHeaders),
        "content-type": "application/json",
        // The pool credential replaces the client's key. The client's own key
        // was already stripped by forwardableRequestHeaders.
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(options.body),
      signal
    });
    return {
      response,
      statusCode: response.status,
      error: response.ok ? null : `Upstream responded ${response.status}`,
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      response: null,
      statusCode: null,
      error: safeError(error),
      latencyMs: Date.now() - startedAt
    };
  }
}

/**
 * Lightweight reachability probe used by the "Test connection" button and the
 * periodic health check. Prefers `GET /models`, which every OpenAI-compatible
 * server implements and which costs no tokens.
 */
export async function probeProvider(options: {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; statusCode: number | null; latencyMs: number; message: string; models?: string[] }> {
  const startedAt = Date.now();
  const url = resolveUpstreamUrl(options.baseUrl, "/v1/models");
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${options.apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000)
    });
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return {
        ok: false,
        statusCode: response.status,
        latencyMs,
        message: `Provider returned ${response.status} ${response.statusText}`.trim()
      };
    }

    const payload = (await response.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null;
    const models = Array.isArray(payload?.data)
      ? payload.data.map((item) => item?.id).filter((id): id is string => typeof id === "string")
      : undefined;

    return {
      ok: true,
      statusCode: response.status,
      latencyMs,
      message: models?.length ? `Reachable — ${models.length} models advertised` : "Reachable",
      models: models?.slice(0, 100)
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      message: safeError(error)
    };
  }
}
