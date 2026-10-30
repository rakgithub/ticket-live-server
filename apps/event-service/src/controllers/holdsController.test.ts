import { describe, expect, it, vi } from "vitest";

const holds = vi.hoisted(() => ({
  create: vi.fn(),
  confirm: vi.fn(),
  release: vi.fn(),
  get: vi.fn(),
}));
vi.mock("../services/inventoryHoldsService.ts", () => ({
  createInventoryHold: holds.create,
  confirmInventoryHold: holds.confirm,
  releaseInventoryHold: holds.release,
  getInventoryHold: holds.get,
  InventoryHoldError: class InventoryHoldError extends Error {
    status = 409;
  },
}));

import { createHold, getHold } from "./holdsController.ts";

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

describe("inventory hold controllers", () => {
  it("rejects invalid request data before calling hold services", async () => {
    const createRes = createResponse();
    await createHold(
      {
        params: { eventId: "11111111-1111-4111-8111-111111111111" },
        body: {},
        header: () => "22222222-2222-4222-8222-222222222222",
      } as never,
      createRes as never,
    );
    expect(createRes.code).toBe(400);

    const getRes = createResponse();
    await getHold({ params: { holdId: "invalid" } } as never, getRes as never);
    expect(getRes.code).toBe(400);
    expect(holds.create).not.toHaveBeenCalled();
    expect(holds.get).not.toHaveBeenCalled();
  });
});
