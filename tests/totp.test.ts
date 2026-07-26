import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totpCode,
  verifyTotp
} from "../apps/gateway/src/lib/totp.js";

/** RFC 6238 Appendix B secret: ASCII "12345678901234567890". */
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");
const RFC_SECRET_B32 = base32Encode(RFC_SECRET);

describe("base32", () => {
  it("encodes the RFC secret to the well-known value", () => {
    expect(RFC_SECRET_B32).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("round-trips arbitrary bytes", () => {
    for (const length of [1, 2, 3, 4, 5, 19, 20, 32]) {
      const input = Buffer.from(Array.from({ length }, (_, i) => (i * 37) % 256));
      expect(base32Decode(base32Encode(input))).toEqual(input);
    }
  });

  it("tolerates lowercase, padding and whitespace", () => {
    expect(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq==")).toEqual(RFC_SECRET);
  });

  it("rejects characters outside the alphabet", () => {
    expect(() => base32Decode("ABC1!")).toThrow(/Invalid base32/);
  });
});

describe("RFC 6238 test vectors (SHA-1, 6 digits)", () => {
  // Appendix B lists 8-digit codes; the 6-digit code is its last 6 digits.
  const vectors: Array<[number, string]> = [
    [59_000, "287082"],
    [1_111_111_109_000, "081804"],
    [1_111_111_111_000, "050471"],
    [1_234_567_890_000, "005924"],
    [2_000_000_000_000, "279037"]
  ];

  for (const [nowMs, expected] of vectors) {
    it(`produces ${expected} at t=${nowMs / 1000}s`, () => {
      expect(totpCode(RFC_SECRET_B32, nowMs)).toBe(expected);
    });
  }

  it("hotp implements dynamic truncation (RFC 4226 vector)", () => {
    // Counter 0 for the same secret is the canonical 755224.
    expect(hotp(RFC_SECRET, 0)).toBe("755224");
  });
});

describe("verification", () => {
  const NOW = 1_234_567_890_000;

  it("accepts the current code", () => {
    expect(verifyTotp(RFC_SECRET_B32, "005924", { nowMs: NOW })).toBe(true);
  });

  it("accepts the previous and next step within the drift window", () => {
    const previous = totpCode(RFC_SECRET_B32, NOW - 30_000);
    const next = totpCode(RFC_SECRET_B32, NOW + 30_000);
    expect(verifyTotp(RFC_SECRET_B32, previous, { nowMs: NOW })).toBe(true);
    expect(verifyTotp(RFC_SECRET_B32, next, { nowMs: NOW })).toBe(true);
  });

  it("rejects a code from outside the window", () => {
    const stale = totpCode(RFC_SECRET_B32, NOW - 120_000);
    expect(verifyTotp(RFC_SECRET_B32, stale, { nowMs: NOW })).toBe(false);
  });

  it("rejects malformed codes without throwing", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "00 592"]) {
      expect(verifyTotp(RFC_SECRET_B32, bad, { nowMs: NOW })).toBe(false);
    }
  });

  it("rejects an invalid secret without throwing", () => {
    expect(verifyTotp("not!base32", "005924", { nowMs: NOW })).toBe(false);
    expect(verifyTotp("", "005924", { nowMs: NOW })).toBe(false);
  });
});

describe("enrolment", () => {
  it("generates a 160-bit secret in base32", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it("generates distinct secrets", () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateTotpSecret()));
    expect(secrets.size).toBe(50);
  });

  it("builds an otpauth URI apps can ingest", () => {
    const uri = otpauthUri("dev@example.com", RFC_SECRET_B32);
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain(`secret=${RFC_SECRET_B32}`);
    expect(uri).toContain("issuer=Codex%20Gateway");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
