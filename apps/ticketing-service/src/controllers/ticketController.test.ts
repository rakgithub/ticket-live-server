import { describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  check: vi.fn(),
  list: vi.fn(),
}));
vi.mock("../services/ticketService.ts", () => ({
  checkInTicket: services.check,
  listTicketsForOrders: services.list,
  TicketCheckInError: class TicketCheckInError extends Error {
    status = 409;
  },
}));

import { checkIn, queryTickets } from "./ticketController.ts";

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

describe("ticket controllers", () => {
  it("rejects malformed query and check-in bodies", async () => {
    const queryRes = createResponse();
    await queryTickets({ body: {} } as never, queryRes as never);
    expect(queryRes.code).toBe(400);

    const checkRes = createResponse();
    await checkIn({ body: {} } as never, checkRes as never);
    expect(checkRes.code).toBe(400);
    expect(services.list).not.toHaveBeenCalled();
    expect(services.check).not.toHaveBeenCalled();
  });
});
