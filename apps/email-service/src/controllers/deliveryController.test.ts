import { describe, expect, it, vi } from "vitest";

const getDeliveryByKey = vi.hoisted(() => vi.fn());
vi.mock("../deliveryStore.ts", () => ({
  getDeliveryByNotificationKey: getDeliveryByKey,
}));

import { getDelivery } from "./deliveryController.ts";

function createResponse() {
  return {
    code: 200,
    status(code: number) {
      this.code = code;
      return this;
    },
    json(body: unknown) {
      return body;
    },
  };
}

describe("delivery controller", () => {
  it("rejects empty notification keys before looking up a delivery", async () => {
    const res = createResponse();
    await getDelivery({ params: { notificationKey: " " } } as never, res as never);
    expect(res.code).toBe(400);
    expect(getDeliveryByKey).not.toHaveBeenCalled();
  });
});
