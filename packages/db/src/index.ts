import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __cgwPrisma: PrismaClient | undefined;
}

/**
 * A single client per process. `tsx watch` re-imports modules on every change,
 * so without the global cache each reload would leak a connection pool.
 */
export const prisma: PrismaClient =
  globalThis.__cgwPrisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === "true" ? ["query", "warn", "error"] : ["warn", "error"]
  });

if (process.env.NODE_ENV !== "production") globalThis.__cgwPrisma = prisma;

/** Prisma returns BigInt for token columns; JSON.stringify cannot encode those. */
export const asNumber = (value: bigint | number | null | undefined): number =>
  value == null ? 0 : typeof value === "bigint" ? Number(value) : value;
