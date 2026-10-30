import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  checkout: vi.fn(),
  list: vi.fn(),
}));
vi.mock("../services/orders/checkoutService.ts", () => ({
  checkout: services.checkout,
  CheckoutError: class CheckoutError extends Error {
    status = 409;
  },
}));
vi.mock("../services/orders/listOrdersService.ts", () => ({
  listOrdersForUser: services.list,
}));

import { getOrders, postCheckout } from "./ordersController.ts";

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

beforeEach(() => {
  vi.clearAllMocks();
  services.list.mockResolvedValue([]);
});

describe("order controllers", () => {
  it("rejects invalid actor IDs and lists orders for valid actors", async () => {
    const invalid = createResponse();
    await getOrders({ header: () => "bad" } as never, invalid as never);
    expect(invalid.code).toBe(400);

    const valid = createResponse();
    await getOrders(
      { header: () => "44444444-4444-4444-8444-444444444444" } as never,
      valid as never,
    );
    expect(services.list).toHaveBeenCalledOnce();
  });

  it("validates checkout headers and body before calling the service", async () => {
    const invalid = createResponse();
    await postCheckout(
      { body: {}, header: () => "bad" } as never,
      invalid as never,
    );
    expect(invalid.code).toBe(400);
    expect(services.checkout).not.toHaveBeenCalled();
  });
});
