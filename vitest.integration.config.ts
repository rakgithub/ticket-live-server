import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/**/*.integration.test.ts",
      "packages/**/*.integration.test.ts",
      "tests/**/*.integration.test.ts",
    ],
    exclude: ["**/outbox.integration.test.ts", "node_modules/**", "dist/**"],
    environment: "node",
    setupFiles: ["./tests/publicApi.setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
