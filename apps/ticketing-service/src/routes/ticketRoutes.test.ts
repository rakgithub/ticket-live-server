import { describe, expect, it } from "vitest";
import routes from "./ticketRoutes.ts";

describe("ticketRoutes", () => {
  it("maps query before check-in", () => {
    const stack = (routes as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    }).stack;
    expect(stack.map((layer) => [
      layer.route?.path,
      Object.keys(layer.route?.methods ?? {})[0],
    ])).toEqual([
      ["/internal/tickets/query", "post"],
      ["/internal/tickets/check-in", "post"],
    ]);
  });
});
