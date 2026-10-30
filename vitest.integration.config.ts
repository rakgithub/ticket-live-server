import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/public-api/src/**/*.integration.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    environment: "node",
    setupFiles: ["./tests/publicApi.setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
