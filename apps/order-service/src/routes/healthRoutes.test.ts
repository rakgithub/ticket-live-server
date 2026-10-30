import { describe, expect, it } from "vitest";
import routes from "./healthRoutes.ts";

describe("healthRoutes", () => {
  it("registers endpoints in the intended order", () => {
    const stack = (routes as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    }).stack;
    expect(stack.map((layer) => [
      layer.route?.path,
      Object.keys(layer.route?.methods ?? {})[0],
    ])).toEqual([
      ["/health/live", "get"],
      ["/health/ready", "get"],
      ["/metrics", "get"],
    ]);
  });
});
