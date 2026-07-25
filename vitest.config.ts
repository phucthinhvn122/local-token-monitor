import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@ltm/shared-types": path.resolve("packages/shared-types/src/index.ts"),
      "@ltm/core": path.resolve("packages/core/src/index.ts"),
      "@ltm/database": path.resolve("packages/database/src/index.ts"),
      "@ltm/collectors": path.resolve("packages/collectors/src/index.ts"),
      "@ltm/provider-codex": path.resolve("packages/provider-codex/src/index.ts"),
      "@ltm/provider-claude": path.resolve("packages/provider-claude/src/index.ts"),
      "@ltm/provider-quota": path.resolve("packages/provider-quota/src/index.ts"),
      "@ltm/token-estimator": path.resolve("packages/token-estimator/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
