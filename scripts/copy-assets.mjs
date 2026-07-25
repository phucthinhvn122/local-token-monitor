import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/migrations", { recursive: true });
await cp("packages/database/src/migrations/001_initial.sql", "dist/migrations/001_initial.sql");
await cp("packages/database/src/pricing.json", "dist/pricing.json");
