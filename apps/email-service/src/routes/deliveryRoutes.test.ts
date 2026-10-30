import { describe, expect, it } from "vitest";
import routes from "./deliveryRoutes.ts";

describe("deliveryRoutes", () => {
  it("retains the notification key parameter", () => {
    const stack = (routes as unknown as {
      stack: Array<{ route?: { path: string } }>;
    }).stack;
    expect(stack[0]?.route?.path).toBe(
      "/internal/deliveries/:notificationKey",
    );
  });
});
