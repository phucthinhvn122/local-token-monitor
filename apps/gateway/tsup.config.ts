import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  // Prisma's client is generated at install time and must stay external.
  external: ["@prisma/client", ".prisma/client"],
  // The workspace packages are TypeScript sources, so they are bundled in.
  noExternal: ["@cgw/core", "@cgw/db", "@cgw/shared", "@cgw/token-estimator"]
});
