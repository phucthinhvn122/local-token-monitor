import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

let schemaReady: Promise<void> | undefined;

export function ensureQuotaSchema() {
  if (!schemaReady) {
    schemaReady = env.DB.exec(
      "CREATE TABLE IF NOT EXISTS public_quota_snapshots (id integer PRIMARY KEY NOT NULL, token_limit integer NOT NULL, token_used integer NOT NULL, token_remaining integer NOT NULL, observed_at text NOT NULL, published_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);"
    ).then(() => undefined);
  }
  return schemaReady;
}

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}
