import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/migrations", { recursive: true });
await cp("packages/database/src/migrations", "dist/migrations", { recursive: true });
await cp("packages/database/src/pricing.json", "dist/pricing.json");
