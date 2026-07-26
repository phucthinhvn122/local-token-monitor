import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const publicQuotaSnapshots = sqliteTable("public_quota_snapshots", {
  id: integer("id").primaryKey(),
  limit: integer("token_limit").notNull(),
  used: integer("token_used").notNull(),
  remaining: integer("token_remaining").notNull(),
  observedAt: text("observed_at").notNull(),
  publishedAt: text("published_at").notNull().default(sql`CURRENT_TIMESTAMP`)
});
