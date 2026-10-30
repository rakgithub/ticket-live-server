import { describe, expect, it } from "vitest";
import { createHealthRoutes } from "./healthRoutes.ts";

describe("healthRoutes", () => {
  it("registers metrics before health and uses injected readiness", () => {
    const routes = createHealthRoutes(() => true);
    const stack = (routes as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    }).stack;
    expect(stack.map((layer) => [
      layer.route?.path,
      Object.keys(layer.route?.methods ?? {})[0],
    ])).toEqual([
      ["/metrics", "get"],
      ["/health/live", "get"],
      ["/health/ready", "get"],
    ]);
  });
});
