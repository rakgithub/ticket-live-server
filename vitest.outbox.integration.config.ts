import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/order-service/src/outbox.integration.test.ts"],
    environment: "node",
    setupFiles: ["./tests/publicApi.setup.ts"],
  },
});
