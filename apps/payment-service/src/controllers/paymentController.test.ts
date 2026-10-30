import { describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  charge: vi.fn(),
  lookup: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("../services/paymentService.ts", () => ({
  chargePayment: services.charge,
  getPaymentByOrder: services.lookup,
  cancelPayment: services.cancel,
}));

import {
  getPayment,
  postPayment,
  postPaymentCancellation,
} from "./paymentController.ts";

function createResponse() {
  return {
    code: 200,
    body: undefined as unknown,
    status(code: number) {
      this.code = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

describe("payment controllers", () => {
  it("rejects invalid charge bodies and order IDs", async () => {
    const chargeRes = createResponse();
    await postPayment({ body: {} } as never, chargeRes as never);
    expect(chargeRes.code).toBe(400);

    const lookupRes = createResponse();
    await getPayment({ params: { orderId: "bad" } } as never, lookupRes as never);
    expect(lookupRes.code).toBe(400);

    const cancelRes = createResponse();
    await postPaymentCancellation(
      { params: { orderId: "bad" } } as never,
      cancelRes as never,
    );
    expect(cancelRes.code).toBe(400);
    expect(services.charge).not.toHaveBeenCalled();
  });
});
