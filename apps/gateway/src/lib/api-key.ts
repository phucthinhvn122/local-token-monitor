import { randomBytes } from "node:crypto";
import { sha256 } from "@cgw/core";

export const API_KEY_PREFIX = "sk-cgw-";
/** 32 bytes of entropy, base64url encoded. */
const SECRET_BYTES = 32;
/** How many characters of the secret are shown in the UI alongside the prefix. */
const VISIBLE_CHARS = 8;

export interface GeneratedApiKey {
  /** The full key. Returned to the caller exactly once, never persisted. */
  plaintext: string;
  keyHash: string;
  keyPrefix: string;
}

/**
 * Keys are hashed with a single SHA-256 pass rather than a KDF. That is the
 * right choice here: unlike a password, the key is 256 bits of CSPRNG output
 * with no guessable structure, and the gateway must look it up on the hot path
 * of every proxied request — a deliberately slow hash would cost real latency
 * while buying nothing against an offline attack that cannot succeed anyway.
 */
export function generateApiKey(): GeneratedApiKey {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const plaintext = `${API_KEY_PREFIX}${secret}`;
  return {
    plaintext,
    keyHash: hashApiKey(plaintext),
    keyPrefix: `${API_KEY_PREFIX}${secret.slice(0, VISIBLE_CHARS)}`
  };
}

export function hashApiKey(plaintext: string): string {
  return sha256(plaintext.trim());
}

/** `sk-cgw-a1b2c3d4****` — the only form ever shown after creation. */
export function maskKey(keyPrefix: string): string {
  return `${keyPrefix}****`;
}

/** Extract a bearer token from an Authorization header, or null. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

export function looksLikeGatewayKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}
