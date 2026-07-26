/**
 * Idempotent seed: default model pricing, the settings singleton, and — when
 * ADMIN_EMAIL/ADMIN_PASSWORD are set — a bootstrap administrator.
 *
 * Safe to run against an existing database: every write is an upsert keyed on a
 * natural identifier, so nothing is overwritten or duplicated.
 */
import { randomBytes, scryptSync } from "node:crypto";
import { prisma } from "./index.js";

/** Mirrors apps/gateway/src/lib/crypto.ts; duplicated to keep the seed dependency-free. */
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 16_384 });
  return `scrypt$16384$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

const PRICING = [
  { modelPattern: "gpt-5-codex", inputPerMillion: 1.25, outputPerMillion: 10, cachedPerMillion: 0.125 },
  { modelPattern: "gpt-5", inputPerMillion: 1.25, outputPerMillion: 10, cachedPerMillion: 0.125 },
  { modelPattern: "gpt-4o-mini", inputPerMillion: 0.15, outputPerMillion: 0.6, cachedPerMillion: 0.075 },
  { modelPattern: "gpt-4o", inputPerMillion: 2.5, outputPerMillion: 10, cachedPerMillion: 1.25 },
  { modelPattern: "claude-sonnet", inputPerMillion: 3, outputPerMillion: 15, cachedPerMillion: 0.3 },
  { modelPattern: "claude-opus", inputPerMillion: 15, outputPerMillion: 75, cachedPerMillion: 1.5 },
  { modelPattern: "claude-haiku", inputPerMillion: 0.8, outputPerMillion: 4, cachedPerMillion: 0.08 }
];

async function main(): Promise<void> {
  for (const row of PRICING) {
    await prisma.modelPricing.upsert({
      where: { modelPattern: row.modelPattern },
      update: {},
      create: row
    });
  }
  console.log(`Seeded ${PRICING.length} model pricing rows.`);

  await prisma.systemSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  console.log("System settings ready.");

  const email = process.env.ADMIN_EMAIL?.toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    const existing = await prisma.user.count({ where: { role: "ADMIN" } });
    if (existing === 0) {
      await prisma.user.create({
        data: { email, name: "Administrator", role: "ADMIN", passwordHash: hashPassword(password) }
      });
      console.log(`Created bootstrap administrator: ${email}`);
    } else {
      console.log("An administrator already exists; skipping bootstrap user.");
    }
  } else {
    console.log("ADMIN_EMAIL/ADMIN_PASSWORD not set; skipping bootstrap user.");
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
