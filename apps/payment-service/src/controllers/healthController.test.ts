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

describe("payment health controller", () => {
  it("reports database readiness and emits metrics", async () => {
    query.mockRejectedValueOnce(new Error("database unavailable"));
    const down = createResponse();
    await getReadiness({} as never, down as never);
    expect(down.code).toBe(503);

    const live = createResponse();
    getLiveness({} as never, live as never);
    expect(live.body).toEqual({ status: "ok" });

    const metrics = createResponse();
    getMetrics({} as never, metrics as never);
    expect(exporter).toHaveBeenCalledWith(
      undefined,
      "ticket-live-payment-service",
    );
  });
});
