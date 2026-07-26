/**
 * Demo data for evaluating the dashboard.
 *
 * Creates three pool providers, three members spread across the safe / warning
 * / critical quota bands, and 30 days of backdated usage so every chart, badge
 * and colour state has something to show.
 *
 * Writes through Prisma directly rather than the HTTP API, so it can run before
 * the gateway is started. Refuses to run against a database that already has
 * members, so it cannot damage a real installation.
 *
 *   npm run db:seed:demo
 *
 * Wipe it again with:  npm run db:seed:demo -- --reset
 */
import { randomBytes, createHash, createCipheriv, scryptSync } from "node:crypto";
import { prisma } from "./index.js";

const RESET = process.argv.includes("--reset");
const DEMO_EMAILS = ["an.nguyen@example.com", "binh.tran@example.com", "chi.le@example.com"];
const DEMO_PROVIDERS = ["Primary pool", "Backup pool", "Legacy pool (offline)"];

/* ---- crypto helpers, mirroring apps/gateway/src/lib/crypto.ts ------------ */

function parseEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32) return decoded;
  throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars or base64).");
}

function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$16384$${salt.toString("base64url")}$${scryptSync(password, salt, 64, { N: 16_384 }).toString("base64url")}`;
}

function generateApiKey() {
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `sk-cgw-${secret}`;
  return {
    plaintext,
    keyHash: createHash("sha256").update(plaintext).digest("hex"),
    keyPrefix: `sk-cgw-${secret.slice(0, 8)}`
  };
}

/* ------------------------------------------------------------------------- */

async function reset(): Promise<void> {
  await prisma.usageLog.deleteMany({ where: { apiKey: { user: { email: { in: DEMO_EMAILS } } } } });
  await prisma.user.deleteMany({ where: { email: { in: DEMO_EMAILS } } });
  await prisma.poolProvider.deleteMany({ where: { name: { in: DEMO_PROVIDERS } } });
  console.log("Demo data removed.");
}

async function main(): Promise<void> {
  if (RESET) {
    await reset();
    return;
  }

  const encryptionKey = parseEncryptionKey(
    process.env.ENCRYPTION_KEY ?? (() => { throw new Error("ENCRYPTION_KEY must be set."); })()
  );

  if (await prisma.user.count({ where: { role: "USER" } })) {
    console.error("This database already has members. Refusing to add demo data.");
    console.error("Run with --reset first if you really want to reseed.");
    process.exitCode = 1;
    return;
  }

  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
  if (!admin) {
    console.error("No administrator found. Run `npm run db:seed` first.");
    process.exitCode = 1;
    return;
  }

  /* ---------------------------------------------------------- providers */

  const primary = await prisma.poolProvider.create({
    data: {
      name: "Primary pool",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEncrypted: encryptSecret("sk-demo-primary-not-a-real-key", encryptionKey),
      apiKeyLast4: "1234",
      wireApi: "CHAT",
      priority: 1,
      weight: 3,
      lastHealthCheck: new Date(),
      lastHealthOk: true,
      lastHealthLatency: 142
    }
  });

  await prisma.poolProvider.create({
    data: {
      name: "Backup pool",
      baseUrl: "https://api.example-provider.com/v1",
      apiKeyEncrypted: encryptSecret("sk-demo-backup-not-a-real-key", encryptionKey),
      apiKeyLast4: "5678",
      wireApi: "CHAT",
      priority: 5,
      weight: 1,
      lastHealthCheck: new Date(),
      lastHealthOk: true,
      lastHealthLatency: 268
    }
  });

  // Deliberately unhealthy, so the circuit-breaker UI has something to show.
  await prisma.poolProvider.create({
    data: {
      name: "Legacy pool (offline)",
      baseUrl: "https://legacy.example.com/v1",
      apiKeyEncrypted: encryptSecret("sk-demo-legacy-not-a-real-key", encryptionKey),
      apiKeyLast4: "9012",
      wireApi: "CHAT",
      priority: 9,
      consecutiveErrors: 4,
      circuitOpenUntil: new Date(Date.now() + 3 * 60_000),
      lastHealthCheck: new Date(Date.now() - 4 * 60_000),
      lastHealthOk: false,
      lastErrorAt: new Date(Date.now() - 4 * 60_000),
      lastErrorMessage: "Upstream responded 503"
    }
  });

  /* ------------------------------------------------- users, keys, usage */

  const people = [
    { email: DEMO_EMAILS[0], name: "An Nguyen", quota: 5_000_000, usedFraction: 0.148 },
    { email: DEMO_EMAILS[1], name: "Binh Tran", quota: 2_000_000, usedFraction: 0.92 },
    { email: DEMO_EMAILS[2], name: "Chi Le", quota: 1_000_000, usedFraction: 0.985 }
  ];

  const models = ["gpt-5-codex", "gpt-5-codex", "gpt-5-codex", "gpt-4o"];
  const issued: Array<{ email: string; plaintext: string }> = [];

  for (const person of people) {
    const key = generateApiKey();
    const used = Math.round(person.quota * person.usedFraction);

    const user = await prisma.user.create({
      data: {
        email: person.email,
        name: person.name,
        role: "USER",
        passwordHash: hashPassword("password123"),
        lastLoginAt: new Date(Date.now() - 3_600_000)
      }
    });

    const apiKey = await prisma.apiKey.create({
      data: {
        userId: user.id,
        name: "Codex CLI key",
        keyHash: key.keyHash,
        keyPrefix: key.keyPrefix,
        keyEncrypted: encryptSecret(key.plaintext, encryptionKey),
        tokenQuota: BigInt(person.quota),
        tokenUsed: BigInt(used),
        createdByAdminId: admin.id,
        lastUsedAt: new Date(Date.now() - 45 * 60_000)
      }
    });

    await prisma.tokenTransaction.createMany({
      data: [
        { apiKeyId: apiKey.id, adminId: admin.id, amount: BigInt(person.quota), type: "GRANT", note: "Demo allocation" },
        { apiKeyId: apiKey.id, amount: BigInt(-used), type: "DEDUCT", note: "Aggregated demo usage" }
      ]
    });

    // Spread `used` across 30 days with a weekly rhythm, so the trend line and
    // the burn-rate projection both have realistic shape.
    const rows = [];
    let remaining = used;

    for (let day = 29; day >= 0 && remaining > 0; day--) {
      const weekday = (day + 3) % 7;
      const intensity = weekday === 0 || weekday === 6 ? 0.25 : 1;
      const calls = Math.max(1, Math.round((3 + ((day * 7) % 9)) * intensity));

      for (let i = 0; i < calls && remaining > 0; i++) {
        const input = 800 + ((day * 617 + i * 331) % 5200);
        const output = 200 + ((day * 271 + i * 149) % 1800);
        const total = Math.min(remaining, input + output);
        const failed = (day * 13 + i) % 47 === 0;
        remaining -= failed ? 0 : total;

        const createdAt = new Date(Date.now() - day * 86_400_000);
        createdAt.setHours(8 + ((i * 3) % 11), (i * 7) % 60, 0, 0);

        rows.push({
          apiKeyId: apiKey.id,
          providerId: primary.id,
          model: models[(day + i) % models.length],
          sessionId: `codex-${person.email.split("@")[0]}-${day}-${Math.floor(i / 4)}`,
          endpoint: "/v1/chat/completions",
          streamed: i % 3 !== 0,
          inputTokens: input,
          outputTokens: output,
          cachedTokens: day % 3 === 0 ? Math.round(input * 0.3) : 0,
          totalTokens: failed ? 0 : total,
          accuracy: "exact",
          latencyMs: 900 + ((day * 97 + i * 53) % 4200),
          statusCode: failed ? 503 : 200,
          errorMessage: failed ? "Upstream responded 503" : null,
          createdAt
        });
      }
    }

    await prisma.usageLog.createMany({ data: rows });
    issued.push({ email: person.email, plaintext: key.plaintext });
    console.log(`  ${person.email.padEnd(24)} ${rows.length} requests, ${used.toLocaleString()} / ${person.quota.toLocaleString()} tokens`);
  }

  console.log("\nDemo sign-ins (password: password123):");
  for (const person of issued) console.log(`  ${person.email}`);
  console.log("\nAPI keys — shown once, exactly as the real flow does:");
  for (const person of issued) console.log(`  ${person.email.padEnd(24)} ${person.plaintext}`);
  console.log("\nThe pool providers point at placeholder URLs, so proxied calls will");
  console.log("fail until you replace them with a real upstream in Admin -> Pool providers.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
