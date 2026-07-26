import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac
} from "node:crypto";

/* ------------------------------------------------ pool credential encryption */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const VERSION = "v1";

/** Accepts a 64-char hex key or a base64/base64url key that decodes to 32 bytes. */
export function parseEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32) return decoded;
  throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars or base64).");
}

/**
 * AES-256-GCM. Output format: `v1:<iv>:<authTag>:<ciphertext>`, each part
 * base64url. The version prefix lets a future key rotation detect old records.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [version, ivPart, tagPart, dataPart] = payload.split(":");
  if (version !== VERSION || !ivPart || !tagPart || !dataPart) {
    throw new Error("Malformed encrypted payload.");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
}

/* ------------------------------------------------------------- passwords */

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16_384;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST });
  return `scrypt$${SCRYPT_COST}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, costPart, saltPart, hashPart] = stored.split("$");
  if (scheme !== "scrypt" || !costPart || !saltPart || !hashPart) return false;
  const expected = Buffer.from(hashPart, "base64url");
  try {
    const derived = scryptSync(password, Buffer.from(saltPart, "base64url"), expected.length, {
      N: Number(costPart)
    });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------- session tokens */

interface SessionClaims {
  sub: string;
  role: string;
  jti: string;
  exp: number;
}

const b64 = (value: object | string): string =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/**
 * Compact HS256 token. Deliberately hand-rolled rather than pulling a JWT
 * library: the gateway only ever issues and verifies its own tokens, and the
 * server-side `sessions` table is what actually authorises a request, so the
 * token is a signed pointer rather than a self-contained credential.
 */
export function signSessionToken(claims: SessionClaims, secret: string): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64(claims);
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function verifySessionToken(token: string, secret: string): SessionClaims | null {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return null;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}
