import { describe, expect, it } from "vitest";
import routes from "./eventsRoutes.ts";

describe("eventsRoutes", () => {
  it("preserves route order and keeps path parameters on their own routes", () => {
    const stack = (routes as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    }).stack;
    expect(stack.map((layer) => [
      layer.route?.path,
      Object.keys(layer.route?.methods ?? {})[0],
    ])).toEqual([
      ["/internal/events", "get"],
      ["/internal/events/search", "get"],
      ["/internal/events", "post"],
      ["/internal/events/:eventId", "patch"],
      ["/internal/events/:eventId/cancel", "post"],
      ["/internal/events/:eventId", "delete"],
      ["/internal/event-search", "get"],
      ["/internal/event-cards", "get"],
      ["/internal/events/:eventId/holds", "post"],
      ["/internal/holds/:holdId/confirm", "post"],
      ["/internal/holds/:holdId/release", "post"],
      ["/internal/holds/:holdId", "get"],
    ]);
  });
});
