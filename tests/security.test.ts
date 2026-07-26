import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  parseEncryptionKey,
  signSessionToken,
  verifyPassword,
  verifySessionToken
} from "../apps/gateway/src/lib/crypto.js";
import { API_KEY_PREFIX, generateApiKey, hashApiKey, maskKey, parseBearer } from "../apps/gateway/src/lib/api-key.js";
import { forwardableRequestHeaders, forwardableResponseHeaders } from "../apps/gateway/src/lib/http.js";
import { buildStoredZip } from "../apps/gateway/src/routes/me.js";
import { redactSecrets, safeError } from "../packages/core/src/index.js";

const KEY = parseEncryptionKey("a".repeat(64));

describe("encryption key parsing", () => {
  it("accepts 64 hex characters", () => {
    expect(parseEncryptionKey("b".repeat(64))).toHaveLength(32);
  });

  it("accepts base64 that decodes to 32 bytes", () => {
    expect(parseEncryptionKey(Buffer.alloc(32, 7).toString("base64"))).toHaveLength(32);
  });

  it("rejects anything that is not 32 bytes", () => {
    expect(() => parseEncryptionKey("tooshort")).toThrow(/32 bytes/);
  });
});

describe("pool credential encryption", () => {
  it("round-trips a secret", () => {
    const secret = "sk-upstream-abcdef123456";
    expect(decryptSecret(encryptSecret(secret, KEY), KEY)).toBe(secret);
  });

  it("produces a different ciphertext each time", () => {
    // A fresh IV per encryption means identical plaintexts are not linkable.
    expect(encryptSecret("same", KEY)).not.toBe(encryptSecret("same", KEY));
  });

  it("never leaves the plaintext visible in the stored payload", () => {
    expect(encryptSecret("sk-upstream-SECRET", KEY)).not.toContain("SECRET");
  });

  it("rejects a tampered ciphertext", () => {
    const payload = encryptSecret("secret", KEY);
    const parts = payload.split(":");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join(":"), KEY)).toThrow();
  });

  it("rejects decryption under a different key", () => {
    const other = parseEncryptionKey("c".repeat(64));
    expect(() => decryptSecret(encryptSecret("secret", KEY), other)).toThrow();
  });

  it("rejects a malformed payload", () => {
    expect(() => decryptSecret("garbage", KEY)).toThrow(/Malformed/);
  });
});

describe("passwords", () => {
  it("verifies the correct password", () => {
    expect(verifyPassword("correct horse battery", hashPassword("correct horse battery"))).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(verifyPassword("wrong", hashPassword("correct horse battery"))).toBe(false);
  });

  it("salts, so the same password hashes differently", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects a malformed stored hash instead of throwing", () => {
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
  });
});

describe("session tokens", () => {
  const SECRET = "s".repeat(40);
  const claims = { sub: "user-1", role: "ADMIN", jti: "abc", exp: Math.floor(Date.now() / 1000) + 3600 };

  it("verifies a token it signed", () => {
    expect(verifySessionToken(signSessionToken(claims, SECRET), SECRET)?.sub).toBe("user-1");
  });

  it("rejects a token signed with another secret", () => {
    expect(verifySessionToken(signSessionToken(claims, SECRET), "other".repeat(10))).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signSessionToken(claims, SECRET);
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, role: "ADMIN", sub: "attacker" })).toString("base64url");
    expect(verifySessionToken(`${header}.${forged}.${signature}`, SECRET)).toBeNull();
  });

  it("rejects an expired token", () => {
    const expired = { ...claims, exp: Math.floor(Date.now() / 1000) - 10 };
    expect(verifySessionToken(signSessionToken(expired, SECRET), SECRET)).toBeNull();
  });

  it("rejects a structurally invalid token", () => {
    expect(verifySessionToken("not.a.token", SECRET)).toBeNull();
    expect(verifySessionToken("", SECRET)).toBeNull();
  });
});

describe("API keys", () => {
  it("issues a prefixed key with a matching hash", () => {
    const key = generateApiKey();
    expect(key.plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(hashApiKey(key.plaintext)).toBe(key.keyHash);
  });

  it("issues a distinct key every time", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().plaintext));
    expect(keys.size).toBe(200);
  });

  it("exposes only the prefix for display", () => {
    const key = generateApiKey();
    expect(key.keyPrefix.length).toBeLessThan(key.plaintext.length);
    expect(key.plaintext.startsWith(key.keyPrefix)).toBe(true);
    expect(maskKey(key.keyPrefix)).toBe(`${key.keyPrefix}****`);
    expect(maskKey(key.keyPrefix)).not.toBe(key.plaintext);
  });

  it("parses a bearer header and ignores anything else", () => {
    expect(parseBearer("Bearer sk-cgw-abc")).toBe("sk-cgw-abc");
    expect(parseBearer("bearer sk-cgw-abc")).toBe("sk-cgw-abc");
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer("Bearer   ")).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
  });
});

describe("header forwarding", () => {
  it("strips the client credential so it never reaches an upstream", () => {
    const headers = forwardableRequestHeaders({
      authorization: "Bearer sk-cgw-secret",
      cookie: "session=abc",
      host: "gateway.example.com",
      "content-type": "application/json",
      "user-agent": "codex-cli/1.0"
    });
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers.host).toBeUndefined();
    expect(headers["user-agent"]).toBe("codex-cli/1.0");
  });

  it("drops hop-by-hop and proxy metadata", () => {
    const headers = forwardableRequestHeaders({
      "transfer-encoding": "chunked",
      "content-length": "42",
      "x-forwarded-for": "1.2.3.4",
      "cf-connecting-ip": "1.2.3.4"
    });
    expect(Object.keys(headers)).toHaveLength(0);
  });

  it("does not relay upstream cookies or CORS decisions to the client", () => {
    const upstream = new Headers({
      "set-cookie": "upstream=1",
      "content-encoding": "gzip",
      "access-control-allow-origin": "*",
      "x-request-id": "req-1"
    });
    const headers = forwardableResponseHeaders(upstream);
    expect(headers["set-cookie"]).toBeUndefined();
    expect(headers["content-encoding"]).toBeUndefined();
    expect(headers["access-control-allow-origin"]).toBeUndefined();
    expect(headers["x-request-id"]).toBe("req-1");
  });
});

describe("secret redaction", () => {
  it("removes API keys from free text", () => {
    expect(redactSecrets("failed with sk-abcdef1234567890")).not.toContain("abcdef1234567890");
  });

  it("removes bearer tokens", () => {
    expect(redactSecrets("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
  });

  it("bounds the length of an error message", () => {
    expect(safeError(new Error("x".repeat(5000))).length).toBeLessThanOrEqual(500);
  });
});

describe("setup bundle zip", () => {
  const zip = buildStoredZip([
    { name: "config.toml", content: 'model = "gpt-5-codex"\n' },
    { name: "install.sh", content: "#!/usr/bin/env bash\n" }
  ]);

  it("starts with the local file header signature", () => {
    expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304");
  });

  it("ends with the end-of-central-directory record", () => {
    expect(zip.subarray(-22, -18).toString("hex")).toBe("504b0506");
  });

  it("records both entries in the central directory", () => {
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(2);
  });

  it("stores the file contents verbatim", () => {
    expect(zip.toString("utf8")).toContain('model = "gpt-5-codex"');
  });
});
