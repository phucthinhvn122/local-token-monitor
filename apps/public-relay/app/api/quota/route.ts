import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { ensureQuotaSchema, getDb } from "../../../db";
import { publicQuotaSnapshots } from "../../../db/schema";
import {
  PUBLIC_QUOTA_UNIT,
  PUBLIC_QUOTA_WINDOW,
  parsePublicQuotaWrite,
  tokensMatch,
  toPublicQuotaSnapshot,
  toStoredQuotaSnapshot
} from "../../lib/public-quota";

export const dynamic = "force-dynamic";

const PUBLIC_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store, max-age=0",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff"
};

function runtimePublishToken(): string | undefined {
  return (
    (env as unknown as { PUBLIC_QUOTA_PUBLISH_TOKEN?: string }).PUBLIC_QUOTA_PUBLISH_TOKEN ??
    process.env.PUBLIC_QUOTA_PUBLISH_TOKEN
  );
}

export async function GET() {
  await ensureQuotaSchema();
  const db = getDb();
  const [row] = await db
    .select()
    .from(publicQuotaSnapshots)
    .where(eq(publicQuotaSnapshots.id, 1))
    .limit(1);

  if (!row) {
    return Response.json(
      { status: "waiting", window: PUBLIC_QUOTA_WINDOW, unit: PUBLIC_QUOTA_UNIT },
      { headers: PUBLIC_HEADERS }
    );
  }

  return Response.json(
    toPublicQuotaSnapshot({
      limit: row.limit,
      used: row.used,
      remaining: row.remaining,
      observedAt: row.observedAt,
      publishedAt: row.publishedAt
    }),
    { headers: PUBLIC_HEADERS }
  );
}

export async function POST(request: Request) {
  const expectedToken = runtimePublishToken();
  if (!expectedToken) {
    return Response.json({ error: "Publishing is not configured." }, { status: 503 });
  }

  const authorization = request.headers.get("authorization") ?? "";
  const providedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!providedToken || !(await tokensMatch(providedToken, expectedToken))) {
    return Response.json(
      { error: "Unauthorized." },
      {
        status: 401,
        headers: {
          "Cache-Control": "no-store",
          "WWW-Authenticate": "Bearer"
        }
      }
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "A valid JSON body is required." }, { status: 400 });
  }

  try {
    const write = parsePublicQuotaWrite(payload);
    const stored = toStoredQuotaSnapshot(write);
    await ensureQuotaSchema();
    const db = getDb();
    await db
      .insert(publicQuotaSnapshots)
      .values({ id: 1, ...stored })
      .onConflictDoUpdate({
        target: publicQuotaSnapshots.id,
        set: stored
      });

    return Response.json(
      { ok: true, acceptedAt: stored.publishedAt },
      { status: 202, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid quota payload." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}
