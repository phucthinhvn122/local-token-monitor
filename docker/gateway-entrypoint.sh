#!/bin/sh
# Apply migrations and seed reference data before the gateway accepts traffic.
#
# `migrate deploy` only applies migrations that have not run yet, and the seed
# is idempotent, so this is safe on every container start — including restarts
# and scale-ups.
set -e

echo "[entrypoint] Applying database migrations…"
npx prisma migrate deploy --schema packages/db/prisma/schema.prisma

echo "[entrypoint] Seeding reference data…"
npx tsx packages/db/src/seed.ts

echo "[entrypoint] Starting gateway."
exec "$@"
