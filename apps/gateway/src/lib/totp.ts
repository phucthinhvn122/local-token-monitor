import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30-second step) — the profile every
 * authenticator app implements. Hand-rolled on node:crypto because the whole
 * algorithm is ~40 lines and a dependency would be all supply-chain surface,
 * no substance. Verified against the RFC test vectors in tests/totp.test.ts.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Invalid base32 character");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 4226 HOTP with dynamic truncation. */
export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(code % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function totpCode(secretBase32: string, nowMs = Date.now()): string {
  return hotp(base32Decode(secretBase32), Math.floor(nowMs / 1000 / STEP_SECONDS));
}

/**
 * Accept the current step plus ±`window` neighbours, absorbing clock drift
 * between the server and the phone. Comparison is constant-time; a malformed
 * code or secret verifies false rather than throwing.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: { nowMs?: number; window?: number } = {}
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return false;
  }
  if (secret.length === 0) return false;

  const window = options.window ?? 1;
  const counter = Math.floor((options.nowMs ?? Date.now()) / 1000 / STEP_SECONDS);
  const given = Buffer.from(code);

  let matched = false;
  for (let offset = -window; offset <= window; offset++) {
    const expected = Buffer.from(hotp(secret, counter + offset));
    // No early exit: every candidate is compared so timing stays flat.
    if (expected.length === given.length && timingSafeEqual(expected, given)) matched = true;
  }
  return matched;
}

/** 160-bit secret, the size RFC 4226 recommends for SHA-1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The enrolment URI authenticator apps accept via QR scan or manual paste. */
export function otpauthUri(email: string, secretBase32: string, issuer = "Codex Gateway"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
