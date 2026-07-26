import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePublicQuotaWrite,
  toPublicQuotaSnapshot,
  toStoredQuotaSnapshot
} from "../app/lib/public-quota.ts";

test("accepts only the minimal sanitized publisher payload", () => {
  const observedAt = "2026-07-26T00:00:00.000Z";
  const parsed = parsePublicQuotaWrite(
    { limit: 100_000_000, used: 1_270_394, observedAt },
    Date.parse("2026-07-26T00:01:00.000Z")
  );
  assert.deepEqual(parsed, { limit: 100_000_000, used: 1_270_394, observedAt });
});

test("rejects provider details, credentials, and extra fields", () => {
  const observedAt = "2026-07-26T00:00:00.000Z";
  for (const forbidden of ["provider", "url", "cookie", "apiKey", "account"]) {
    assert.throws(() =>
      parsePublicQuotaWrite(
        { limit: 100_000_000, used: 10, observedAt, [forbidden]: "secret" },
        Date.parse("2026-07-26T00:01:00.000Z")
      )
    );
  }
});

test("computes remaining quota and public status on the server", () => {
  const stored = toStoredQuotaSnapshot(
    {
      limit: 100_000_000,
      used: 25_000_000,
      observedAt: "2026-07-26T00:00:00.000Z"
    },
    "2026-07-26T00:00:01.000Z"
  );
  const publicSnapshot = toPublicQuotaSnapshot(
    stored,
    Date.parse("2026-07-26T00:02:00.000Z")
  );
  assert.equal(publicSnapshot.remaining, 75_000_000);
  assert.equal(publicSnapshot.percentUsed, 25);
  assert.equal(publicSnapshot.status, "active");
  assert.equal("provider" in publicSnapshot, false);
});
