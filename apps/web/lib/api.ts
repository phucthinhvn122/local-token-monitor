"use client";

/**
 * Thin fetch wrapper for the gateway API.
 *
 * Requests go to same-origin `/api/*`, which Next rewrites to the gateway, so
 * the session cookie rides along automatically and there is no CORS hop.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string | { message?: string };
      code?: string;
      details?: unknown;
    };
    const message =
      typeof payload.error === "string"
        ? payload.error
        : (payload.error?.message ?? `Request failed (${response.status})`);
    throw new ApiError(response.status, message, payload.code, payload.details);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T,>(path: string) => request<T>(path, { method: "DELETE" })
};

/** Build a query string, dropping empty values so filters stay clean. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}
