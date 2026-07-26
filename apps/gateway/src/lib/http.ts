import type { FastifyReply } from "fastify";
import type { GatewayErrorCode } from "@cgw/shared";

/** An error that carries an HTTP status and is safe to show to the caller. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, "bad_request", details);
export const unauthorized = (message = "Authentication required") => new HttpError(401, message, "unauthorized");
export const forbidden = (message = "Not permitted") => new HttpError(403, message, "forbidden");
export const notFound = (message = "Not found") => new HttpError(404, message, "not_found");
export const conflict = (message: string) => new HttpError(409, message, "conflict");

/**
 * OpenAI-shaped error envelope. Codex CLI and every other OpenAI-compatible
 * client expects `{ error: { message, type, code } }`, so gateway endpoints
 * must not use the dashboard's error shape.
 */
export function sendOpenAiError(
  reply: FastifyReply,
  statusCode: number,
  message: string,
  code: GatewayErrorCode | string,
  type = "invalid_request_error"
): FastifyReply {
  return reply.code(statusCode).send({ error: { message, type, code, param: null } });
}

/** Headers that must never be copied from the client to the upstream. */
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "authorization",
  "cookie",
  "accept-encoding",
  "transfer-encoding",
  "upgrade",
  "expect",
  "proxy-authorization"
]);

/** Headers that must never be copied from the upstream back to the client. */
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "access-control-allow-origin",
  "access-control-allow-credentials"
]);

export function forwardableRequestHeaders(headers: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(lower)) continue;
    // Never leak the caller's identity or our own hop metadata upstream.
    if (lower.startsWith("x-forwarded-") || lower.startsWith("cf-")) continue;
    if (typeof value === "string") result[lower] = value;
  }
  return result;
}

export function forwardableResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (STRIP_RESPONSE_HEADERS.has(lower)) return;
    result[lower] = value;
  });
  return result;
}

export function clientIp(headers: Record<string, unknown>, fallback: string): string {
  const forwarded = headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) return forwarded.split(",")[0].trim();
  return fallback;
}
