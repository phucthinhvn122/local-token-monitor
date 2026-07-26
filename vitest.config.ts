import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@cgw/core": path.resolve("packages/core/src/index.ts"),
      "@cgw/db": path.resolve("packages/db/src/index.ts"),
      "@cgw/shared/codex": path.resolve("packages/shared/src/codex-config.ts"),
      "@cgw/shared": path.resolve("packages/shared/src/index.ts"),
      "@cgw/token-estimator": path.resolve("packages/token-estimator/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
