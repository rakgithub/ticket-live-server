import { describe, expect, it } from "vitest";
import routes from "./paymentRoutes.ts";

describe("paymentRoutes", () => {
  it("maps charge, lookup, and cancellation endpoints", () => {
    const stack = (routes as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    }).stack;
    expect(stack.map((layer) => [
      layer.route?.path,
      Object.keys(layer.route?.methods ?? {})[0],
    ])).toEqual([
      ["/internal/payments", "post"],
      ["/internal/payments/:orderId", "get"],
      ["/internal/payments/:orderId/cancel", "post"],
    ]);
  });
});
