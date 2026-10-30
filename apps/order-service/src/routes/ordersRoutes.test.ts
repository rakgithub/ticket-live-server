import { describe, expect, it } from "vitest";
import routes from "./ordersRoutes.ts";

describe("ordersRoutes", () => {
  it("maps the internal endpoints in their established order", () => {
    const stack = (routes as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    }).stack;
    expect(stack.map((layer) => [
      layer.route?.path,
      Object.keys(layer.route?.methods ?? {})[0],
    ])).toEqual([
      ["/internal/orders", "get"],
      ["/internal/orders/checkout", "post"],
    ]);
  });
});
