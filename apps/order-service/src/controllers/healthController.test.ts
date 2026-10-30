import { describe, expect, it, vi } from "vitest";

const { query, exportMetrics, renderMetrics, mismatch } = vi.hoisted(() => ({
  query: vi.fn(),
  exportMetrics: vi.fn(),
  renderMetrics: vi.fn(() => "# metrics\n"),
  mismatch: vi.fn(() => 3),
}));
vi.mock("../db/client.ts", () => ({ pool: { query } }));
vi.mock("../services/orders/reconcileInventory.ts", () => ({
  getPaymentHoldMismatchTotal: mismatch,
}));
vi.mock("@ticket-live/runtime", () => ({
  exportOtlpMetrics: exportMetrics,
  renderHttpMetrics: renderMetrics,
}));

import { getLiveness, getMetrics, getReadiness } from "./healthController.ts";

function createResponse() {
  return {
    code: 200,
    body: undefined as unknown,
    contentType: "",
    status(code: number) {
      this.code = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    type(value: string) {
      this.contentType = value;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

describe("order health controller", () => {
  it("reports liveness and database readiness", async () => {
    const live = createResponse();
    getLiveness({} as never, live as never);
    expect(live.body).toEqual({ status: "ok" });

    query.mockResolvedValueOnce({});
    const ready = createResponse();
    await getReadiness({} as never, ready as never);
    expect(ready.code).toBe(200);

    query.mockRejectedValueOnce(new Error("database unavailable"));
    const down = createResponse();
    await getReadiness({} as never, down as never);
    expect(down.code).toBe(503);
  });

  it("keeps metrics scrapeable when a database query fails", async () => {
    query.mockRejectedValueOnce(new Error("outbox unavailable"));
    query.mockResolvedValueOnce({
      rows: [{ unresolved: "2", oldest_age_seconds: "1" }],
    });
    const res = createResponse();

    await getMetrics({} as never, res as never);

    expect(res.contentType).toContain("text/plain");
    expect(exportMetrics).toHaveBeenCalledWith(
      undefined,
      "ticket-live-order-service",
    );
    expect(renderMetrics).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ paymentHoldMismatchTotal: 3 }),
    );
  });
});
