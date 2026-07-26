import { Prisma, prisma } from "@cgw/db";
import type { TimeseriesPoint } from "@cgw/shared";

export type RangeKey = "24h" | "7d" | "30d" | "90d";
export type BucketKey = "hour" | "day" | "week";

const RANGE_MS: Record<RangeKey, number> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000
};

export function rangeStart(range: RangeKey, now = new Date()): Date {
  return new Date(now.getTime() - RANGE_MS[range]);
}

export function defaultBucket(range: RangeKey): BucketKey {
  if (range === "24h") return "hour";
  if (range === "90d") return "week";
  return "day";
}

/**
 * Time-bucketed usage rollup.
 *
 * `date_trunc` runs in Postgres rather than in JS because the log table is the
 * one that grows without bound; pulling 90 days of rows into the process to
 * bucket them would be the first thing to fall over. The bucket unit is chosen
 * from a closed set, never interpolated from user input.
 */
export async function usageTimeseries(options: {
  range: RangeKey;
  bucket?: BucketKey;
  apiKeyId?: string;
  userId?: string;
  now?: Date;
}): Promise<TimeseriesPoint[]> {
  const now = options.now ?? new Date();
  const from = rangeStart(options.range, now);
  const bucket = options.bucket ?? defaultBucket(options.range);
  const unit = Prisma.raw(`'${bucket}'`);

  const conditions: Prisma.Sql[] = [Prisma.sql`l.created_at >= ${from}`];
  if (options.apiKeyId) conditions.push(Prisma.sql`l.api_key_id = ${options.apiKeyId}::uuid`);
  if (options.userId) conditions.push(Prisma.sql`k.user_id = ${options.userId}::uuid`);

  const rows = await prisma.$queryRaw<
    Array<{
      bucket: Date;
      requests: bigint;
      total_tokens: bigint | null;
      input_tokens: bigint | null;
      output_tokens: bigint | null;
      errors: bigint;
    }>
  >(Prisma.sql`
    SELECT date_trunc(${unit}, l.created_at) AS bucket,
           COUNT(*)                          AS requests,
           SUM(l.total_tokens)               AS total_tokens,
           SUM(l.input_tokens)               AS input_tokens,
           SUM(l.output_tokens)              AS output_tokens,
           COUNT(*) FILTER (WHERE l.status_code >= 400 OR l.status_code = 0) AS errors
    FROM usage_logs l
    LEFT JOIN api_keys k ON k.id = l.api_key_id
    WHERE ${Prisma.join(conditions, " AND ")}
    GROUP BY 1
    ORDER BY 1 ASC
  `);

  return fillBuckets(
    rows.map((row) => ({
      bucket: row.bucket.toISOString(),
      requests: Number(row.requests),
      totalTokens: Number(row.total_tokens ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      errors: Number(row.errors)
    })),
    from,
    now,
    bucket
  );
}

const BUCKET_MS: Record<BucketKey, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000
};

/**
 * Insert zero-valued points for empty buckets. Charts with gaps read as
 * "no data collected" rather than "no usage", which is the wrong story.
 */
export function fillBuckets(
  points: TimeseriesPoint[],
  from: Date,
  to: Date,
  bucket: BucketKey
): TimeseriesPoint[] {
  const step = BUCKET_MS[bucket];
  const byBucket = new Map(points.map((point) => [truncate(new Date(point.bucket), bucket).getTime(), point]));
  const result: TimeseriesPoint[] = [];
  for (let cursor = truncate(from, bucket).getTime(); cursor <= to.getTime(); cursor += step) {
    result.push(
      byBucket.get(cursor) ?? {
        bucket: new Date(cursor).toISOString(),
        requests: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        errors: 0
      }
    );
  }
  return result;
}

/** Mirror of Postgres `date_trunc` for the three units used here (UTC). */
export function truncate(date: Date, bucket: BucketKey): Date {
  const value = new Date(date);
  value.setUTCMilliseconds(0);
  value.setUTCSeconds(0);
  value.setUTCMinutes(0);
  if (bucket === "hour") return value;
  value.setUTCHours(0);
  if (bucket === "day") return value;
  // Postgres weeks start on Monday.
  const dayOfWeek = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - dayOfWeek);
  return value;
}
