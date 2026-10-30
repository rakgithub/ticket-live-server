import { describe, expect, it, vi } from "vitest";

const { query, ping, exporter } = vi.hoisted(() => ({
  query: vi.fn(),
  ping: vi.fn(),
  exporter: vi.fn(),
}));
vi.mock("../db/client.ts", () => ({ pool: { query } }));
vi.mock("../search/client.ts", () => ({ elasticsearch: { ping } }));
vi.mock("../services/inventoryHoldsService.ts", () => ({
  getInventoryHoldCounters: () => ({
    capacityConflictsTotal: 2,
    expiredHoldsTotal: 1,
  }),
}));
vi.mock("@ticket-live/runtime", () => ({
  exportOtlpMetrics: exporter,
  renderHttpMetrics: () => "metrics",
}));

import { getLiveness, getMetrics, getReadiness } from "./healthController.ts";

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
    type() {
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

describe("event health controller", () => {
  it("checks PostgreSQL and Elasticsearch readiness concurrently", async () => {
    query.mockRejectedValueOnce(new Error("database unavailable"));
    ping.mockResolvedValueOnce({});
    const res = createResponse();

    await getReadiness({} as never, res as never);

    expect(res.code).toBe(503);
    expect(ping).toHaveBeenCalledWith({}, { requestTimeout: 1_000 });
  });

  it("keeps metrics export available when database queries fail", async () => {
    query.mockRejectedValueOnce(new Error("database unavailable"));
    const live = createResponse();
    getLiveness({} as never, live as never);
    expect(live.body).toEqual({ status: "ok" });

    const metrics = createResponse();
    await getMetrics({} as never, metrics as never);
    expect(exporter).toHaveBeenCalledWith(
      undefined,
      "ticket-live-event-service",
    );
  });
});
