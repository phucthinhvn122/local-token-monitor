import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    server: "apps/server/src/run-server.ts",
    cli: "apps/server/src/cli.ts"
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  external: ["node:sqlite"],
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" }
});
