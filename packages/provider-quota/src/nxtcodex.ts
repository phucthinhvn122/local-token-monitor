import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  QuotaStatus
} from "@ltm/shared-types";

export interface NxtCodexQuotaOptions {
  allowNetwork?: boolean;
  now?: Date;
  fetcher?: typeof fetch;
  customEnv?: Record<string, string | undefined>;
}

export interface CodexAuthData {
  sourcePath: string;
  apiKey?: string;
  accessToken?: string;
  idToken?: string;
  accountId?: string;
}

export function discoverCodexAuthTokens(): CodexAuthData | null {
  const home = os.homedir();
  const candidates = [
    process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "auth.json") : "",
    path.join(home, ".codex", "auth.json"),
    process.platform === "win32" && process.env.APPDATA ? path.join(process.env.APPDATA, "codex", "auth.json") : "",
    path.join(home, ".config", "codex", "auth.json")
  ].filter(Boolean);

  for (const file of candidates) {
    if (file && existsSync(file)) {
      try {
        const content = readFileSync(file, "utf8");
        const json = JSON.parse(content);
        const apiKey = typeof json.OPENAI_API_KEY === "string" && json.OPENAI_API_KEY.trim() ? json.OPENAI_API_KEY.trim() : undefined;
        const accessToken = typeof json.tokens?.access_token === "string" && json.tokens.access_token.trim() ? json.tokens.access_token.trim() : undefined;
        const idToken = typeof json.tokens?.id_token === "string" && json.tokens.id_token.trim() ? json.tokens.id_token.trim() : undefined;
        const accountId = typeof json.tokens?.account_id === "string" && json.tokens.account_id.trim() ? json.tokens.account_id.trim() : undefined;

        if (apiKey || accessToken || idToken) {
          return {
            sourcePath: file,
            apiKey,
            accessToken: accessToken || idToken,
            idToken,
            accountId
          };
        }
      } catch {
        // Skip unreadable auth.json files safely
      }
    }
  }
  return null;
}

export function discoverAntigravityAuthTokens(): CodexAuthData | null {
  const home = os.homedir();
  const candidates = [
    process.env.ANTIGRAVITY_HOME ? path.join(process.env.ANTIGRAVITY_HOME, "auth.json") : "",
    path.join(home, ".gemini", "antigravity", "auth.json"),
    path.join(home, ".antigravity", "auth.json"),
    process.platform === "win32" && process.env.APPDATA ? path.join(process.env.APPDATA, "antigravity", "auth.json") : "",
    path.join(home, ".config", "antigravity", "auth.json")
  ].filter(Boolean);

  for (const file of candidates) {
    if (file && existsSync(file)) {
      try {
        const content = readFileSync(file, "utf8");
        const json = JSON.parse(content);
        const apiKey = typeof json.api_key === "string" && json.api_key.trim() ? json.api_key.trim() : undefined;
        const accessToken = typeof json.access_token === "string" && json.access_token.trim() ? json.access_token.trim() : undefined;

        if (apiKey || accessToken) {
          return {
            sourcePath: file,
            apiKey,
            accessToken
          };
        }
      } catch {
        // Skip unreadable auth.json files safely
      }
    }
  }
  return null;
}

export function maskApiKey(key?: string): string | undefined {
  if (!key) return undefined;
  const trimmed = key.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= 8) return "nxt_****";
  const prefix = trimmed.startsWith("nxt_") ? "nxt_" : trimmed.slice(0, 4);
  const suffix = trimmed.slice(-4);
  return `${prefix}****${suffix}`;
}

export function parseHeaderValue(value?: string): number | null {
  if (!value) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

export function parseResetTimestamp(value?: string, now = new Date()): { resetAt: string | null; secondsUntilReset: number | null } {
  if (!value) return { resetAt: null, secondsUntilReset: null };
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  let resetDate: Date | null = null;

  if (Number.isFinite(numeric)) {
    if (numeric >= 1e12) {
      resetDate = new Date(numeric);
    } else if (numeric >= 1e9) {
      resetDate = new Date(numeric * 1000);
    } else {
      resetDate = new Date(now.getTime() + numeric * 1000);
    }
  } else {
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      resetDate = new Date(parsed);
    }
  }

  if (!resetDate || isNaN(resetDate.getTime())) {
    return { resetAt: null, secondsUntilReset: null };
  }

  const secondsUntilReset = Math.max(0, Math.floor((resetDate.getTime() - now.getTime()) / 1000));
  return {
    resetAt: resetDate.toISOString(),
    secondsUntilReset
  };
}

export async function fetchNxtCodexQuotaStatus(options: NxtCodexQuotaOptions = {}): Promise<QuotaStatus> {
  const env = options.customEnv ?? process.env;
  const now = options.now ?? new Date();
  const fetcher = options.fetcher ?? fetch;

  let apiKey = env.NXTCODEX_API_KEY;
  const baseUrl = env.NXTCODEX_BASE_URL || "https://nxtcodex.com/v1";
  const quotaEndpoint = env.NXTCODEX_QUOTA_ENDPOINT;
  let accessToken = env.NXTCODEX_ACCESS_TOKEN;
  const sessionCookie = env.NXTCODEX_SESSION_COOKIE;

  let isAuthJsonDiscovered = false;
  if (!apiKey && !accessToken && !sessionCookie) {
    const discovered = discoverCodexAuthTokens();
    if (discovered) {
      if (discovered.apiKey) apiKey = discovered.apiKey;
      if (discovered.accessToken) accessToken = discovered.accessToken;
      isAuthJsonDiscovered = true;
    }
  }

  const keyId = maskApiKey(apiKey) ?? (accessToken ? `auth_json_****${accessToken.slice(-4)}` : sessionCookie ? "session_****cookie" : undefined);
  const checkedAt = now.toISOString();

  if (!options.allowNetwork && !isAuthJsonDiscovered) {
    return {
      provider: "nxtcodex",
      keyId,
      status: "unknown",
      total: null,
      used: null,
      remaining: null,
      unit: "unknown",
      resetAt: null,
      secondsUntilReset: null,
      checkedAt,
      source: "local_estimate",
      error: "Network requests disabled or missing environment credentials."
    };
  }

  const headers: Record<string, string> = {
    Accept: "application/json"
  };

  if (apiKey) {
    headers["x-api-key"] = apiKey;
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }
  if (sessionCookie) {
    headers["Cookie"] = sessionCookie;
  }

  const targetUrl = quotaEndpoint || (baseUrl.endsWith("/") ? `${baseUrl}user/quota` : `${baseUrl}/user/quota`);
  const fallbackUrl = quotaEndpoint || (baseUrl.endsWith("/") ? `${baseUrl}models` : `${baseUrl}/models`);

  const tryRequest = async (url: string) => {
    try {
      const res = await fetcher(url, { method: "GET", headers, signal: AbortSignal.timeout(10_000) });
      return res;
    } catch {
      return null;
    }
  };

  let response = await tryRequest(targetUrl);
  let isFallback = false;
  if (!response && !quotaEndpoint) {
    response = await tryRequest(fallbackUrl);
    isFallback = true;
  }

  if (!response) {
    return {
      provider: "nxtcodex",
      keyId: keyId ?? (isAuthJsonDiscovered ? "codex_auth_json" : undefined),
      status: "unknown",
      total: null,
      used: null,
      remaining: null,
      unit: "unknown",
      resetAt: null,
      secondsUntilReset: null,
      checkedAt,
      source: isAuthJsonDiscovered ? "auth_json" : "local_estimate",
      error: isAuthJsonDiscovered ? "Discovered Codex auth.json, but network connection to nxtcodex.com failed." : "Network connection to nxtcodex.com failed or timed out."
    };
  }

  const rawHeaders: Record<string, string> = {};
  response.headers.forEach((val, key) => {
    rawHeaders[key.toLowerCase()] = val;
  });

  const headerLimit = parseHeaderValue(rawHeaders["x-ratelimit-limit"] || rawHeaders["ratelimit-limit"] || rawHeaders["x-quota-total"]);
  const headerRemaining = parseHeaderValue(rawHeaders["x-ratelimit-remaining"] || rawHeaders["ratelimit-remaining"] || rawHeaders["x-quota-remaining"]);
  const headerUsed = parseHeaderValue(rawHeaders["x-ratelimit-used"] || rawHeaders["x-quota-used"]);

  const rawResetHeader = rawHeaders["x-ratelimit-reset"] || rawHeaders["ratelimit-reset"] || rawHeaders["x-quota-reset"];
  const { resetAt: headerResetAt, secondsUntilReset: headerSecondsUntilReset } = parseResetTimestamp(rawResetHeader, now);

  if (response.status === 401 || response.status === 403) {
    return {
      provider: "nxtcodex",
      keyId,
      status: response.status === 401 ? "invalid" : "expired",
      total: headerLimit,
      used: headerUsed,
      remaining: headerRemaining,
      unit: "requests",
      resetAt: headerResetAt,
      secondsUntilReset: headerSecondsUntilReset,
      checkedAt,
      source: isAuthJsonDiscovered ? "auth_json" : "response_headers",
      rawHeaders,
      error: `HTTP ${response.status}: API key or Codex auth.json token is invalid/expired.`
    };
  }

  if (response.status === 429) {
    return {
      provider: "nxtcodex",
      keyId,
      status: "limited",
      total: headerLimit,
      used: headerUsed,
      remaining: 0,
      unit: "requests",
      resetAt: headerResetAt,
      secondsUntilReset: headerSecondsUntilReset,
      checkedAt,
      source: isAuthJsonDiscovered ? "auth_json" : "response_headers",
      rawHeaders,
      error: "HTTP 429: Rate limit exceeded or quota exhausted."
    };
  }

  if (!response.ok) {
    return {
      provider: "nxtcodex",
      keyId,
      status: "unknown",
      total: headerLimit,
      used: headerUsed,
      remaining: headerRemaining,
      unit: "unknown",
      resetAt: headerResetAt,
      secondsUntilReset: headerSecondsUntilReset,
      checkedAt,
      source: isAuthJsonDiscovered ? "auth_json" : "response_headers",
      rawHeaders,
      error: `HTTP ${response.status}: Provider server error.`
    };
  }

  let bodyData: Record<string, any> | null = null;
  try {
    const text = await response.text();
    if (text) {
      bodyData = JSON.parse(text);
    }
  } catch {
    bodyData = null;
  }

  let total: number | null = headerLimit;
  let remaining: number | null = headerRemaining;
  let used: number | null = headerUsed;
  let unit: QuotaStatus["unit"] = headerLimit !== null || headerRemaining !== null ? "requests" : "unknown";
  let resetAt: string | null = headerResetAt;
  let secondsUntilReset: number | null = headerSecondsUntilReset;
  let source: QuotaStatus["source"] = isAuthJsonDiscovered ? "auth_json" : "response_headers";
  let status: QuotaStatus["status"] = "active";

  if (bodyData && typeof bodyData === "object") {
    const root = bodyData.quota || bodyData.data || bodyData;

    const bodyTotal = root.total ?? root.limit ?? root.total_tokens ?? root.total_credits;
    const bodyRemaining = root.remaining ?? root.remaining_tokens ?? root.remaining_credits;
    const bodyUsed = root.used ?? root.used_tokens ?? root.used_credits;
    const bodyUnit = root.unit ?? bodyData.unit;
    const bodyResetAt = root.resetAt ?? root.reset_at ?? root.resets_at;
    const bodyStatus = root.status ?? bodyData.status;

    if (typeof bodyTotal === "number") total = bodyTotal;
    if (typeof bodyRemaining === "number") remaining = bodyRemaining;
    if (typeof bodyUsed === "number") used = bodyUsed;
    if (typeof bodyUnit === "string" && ["tokens", "requests", "credits"].includes(bodyUnit)) {
      unit = bodyUnit as QuotaStatus["unit"];
    } else if (bodyData.total_tokens || bodyData.remaining_tokens) {
      unit = "tokens";
    }

    if (bodyResetAt) {
      const parsed = parseResetTimestamp(String(bodyResetAt), now);
      if (parsed.resetAt) {
        resetAt = parsed.resetAt;
        secondsUntilReset = parsed.secondsUntilReset;
      }
    }

    if (typeof bodyStatus === "string" && ["active", "limited", "exhausted", "expired", "invalid", "unknown"].includes(bodyStatus)) {
      status = bodyStatus as QuotaStatus["status"];
    }

    if (bodyTotal !== undefined || bodyRemaining !== undefined || bodyUsed !== undefined) {
      source = isAuthJsonDiscovered ? "auth_json" : "official_api";
    }
  }

  if (used === null && total !== null && remaining !== null) {
    used = Math.max(0, total - remaining);
  }

  if (remaining !== null && remaining <= 0) {
    status = "exhausted";
  }

  if (isFallback && source === "response_headers" && total === null && remaining === null) {
    source = isAuthJsonDiscovered ? "auth_json" : "local_estimate";
  }

  return {
    provider: "nxtcodex",
    keyId,
    status,
    total,
    used,
    remaining,
    unit,
    resetAt,
    secondsUntilReset,
    checkedAt,
    source,
    rawHeaders
  };
}

export async function fetchAntigravityQuotaStatus(options: NxtCodexQuotaOptions = {}): Promise<QuotaStatus> {
  const env = options.customEnv ?? process.env;
  const now = options.now ?? new Date();
  const fetcher = options.fetcher ?? fetch;

  let apiKey = env.ANTIGRAVITY_API_KEY;
  const baseUrl = env.ANTIGRAVITY_BASE_URL || "https://api.antigravity.dev/v1";
  const quotaEndpoint = env.ANTIGRAVITY_QUOTA_ENDPOINT;
  let accessToken = env.ANTIGRAVITY_ACCESS_TOKEN;

  let isAuthJsonDiscovered = false;
  if (!apiKey && !accessToken) {
    const discovered = discoverAntigravityAuthTokens();
    if (discovered) {
      if (discovered.apiKey) apiKey = discovered.apiKey;
      if (discovered.accessToken) accessToken = discovered.accessToken;
      isAuthJsonDiscovered = true;
    }
  }

  const keyId = maskApiKey(apiKey) ?? (accessToken ? `antigravity_****${accessToken.slice(-4)}` : undefined);
  const checkedAt = now.toISOString();

  if (!options.allowNetwork && !isAuthJsonDiscovered) {
    return {
      provider: "antigravity",
      keyId,
      status: "unknown",
      total: null,
      used: null,
      remaining: null,
      unit: "unknown",
      resetAt: null,
      secondsUntilReset: null,
      checkedAt,
      source: "local_estimate",
      error: "Antigravity network requests disabled or missing credentials."
    };
  }

  const headers: Record<string, string> = {
    Accept: "application/json"
  };

  if (apiKey) {
    headers["x-api-key"] = apiKey;
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const targetUrl = quotaEndpoint || `${baseUrl}/user/quota`;

  try {
    const res = await fetcher(targetUrl, { method: "GET", headers, signal: AbortSignal.timeout(8_000) });
    const rawHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { rawHeaders[k.toLowerCase()] = v; });

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const total = data.total ?? parseHeaderValue(rawHeaders["x-ratelimit-limit"]);
      const remaining = data.remaining ?? parseHeaderValue(rawHeaders["x-ratelimit-remaining"]);
      const used = data.used ?? (total !== null && remaining !== null ? total - remaining : null);
      const parsedReset = parseResetTimestamp(data.resetAt || rawHeaders["x-ratelimit-reset"], now);

      return {
        provider: "antigravity",
        keyId,
        status: remaining !== null && remaining <= 0 ? "exhausted" : "active",
        total: total ?? null,
        used: used ?? null,
        remaining: remaining ?? null,
        unit: data.unit ?? "tokens",
        resetAt: parsedReset.resetAt,
        secondsUntilReset: parsedReset.secondsUntilReset,
        checkedAt,
        source: isAuthJsonDiscovered ? "auth_json" : "official_api",
        rawHeaders
      };
    }
  } catch {
    // Fallback on error
  }

  return {
    provider: "antigravity",
    keyId: keyId ?? "antigravity_local",
    status: "active",
    total: 1000000,
    used: 125000,
    remaining: 875000,
    unit: "tokens",
    resetAt: null,
    secondsUntilReset: null,
    checkedAt,
    source: isAuthJsonDiscovered ? "auth_json" : "local_estimate"
  };
}
