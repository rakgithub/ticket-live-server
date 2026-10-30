import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "**/node_modules/**", "**/dist/**"],
    setupFiles: ["./tests/publicApi.setup.ts"],
    coverage: {
      provider: "v8",
      include: ["apps/**/*.ts", "packages/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
    },
  },
});
