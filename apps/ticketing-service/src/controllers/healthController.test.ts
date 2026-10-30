import { describe, expect, it, vi } from "vitest";

const { query, exporter } = vi.hoisted(() => ({
  query: vi.fn(),
  exporter: vi.fn(),
}));
vi.mock("../db/client.ts", () => ({ pool: { query } }));
vi.mock("@ticket-live/runtime", () => ({
  exportOtlpMetrics: exporter,
  renderHttpMetrics: () => "metrics",
}));

import {
  createReadinessController,
  getLiveness,
  getMetrics,
} from "./healthController.ts";

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

describe("ticketing health controller", () => {
  it("checks the database and current consumer readiness", async () => {
    query.mockResolvedValue({});
    let consumerReady = true;
    const handler = createReadinessController(() => consumerReady);

    const ready = createResponse();
    await handler({} as never, ready as never);
    expect(query).toHaveBeenCalledWith(
      "SELECT 1 FROM ticketing_service.tickets LIMIT 0",
    );
    expect(ready.code).toBe(200);

    consumerReady = false;
    const down = createResponse();
    await handler({} as never, down as never);
    expect(down.code).toBe(503);

    const live = createResponse();
    getLiveness({} as never, live as never);
    expect(live.body).toEqual({ status: "ok" });

    const metrics = createResponse();
    getMetrics({} as never, metrics as never);
    expect(exporter).toHaveBeenCalledWith(
      undefined,
      "ticket-live-ticketing-service",
    );
  });
});
