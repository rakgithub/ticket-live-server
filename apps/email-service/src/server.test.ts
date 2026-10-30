import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");

describe("server composition", () => {
  it("preserves middleware, route, and lifecycle composition", () => {
    const positions = [
      "const worker = startEmailWorker();",
      "app.use(httpObservabilityMiddleware);",
      "app.use(express.json({ limit: \"100kb\" }));",
      "app.use(\"/internal\", requireInternalServiceAuth);",
      "app.use(createHealthRoutes(() => worker.isReady()));",
      "app.use(deliveryRoutes);",
      "app.listen(env.EMAIL_SERVICE_PORT",
      "process.on(signal",
      "server.close(() =>",
      "worker.stop()",
      "pool.end()",
    ].map((item) => source.indexOf(item));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
