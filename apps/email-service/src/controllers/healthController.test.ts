import { describe, expect, it, vi } from "vitest";

const { query, rows, loggerError } = vi.hoisted(() => ({
  query: vi.fn(),
  rows: vi.fn(),
  loggerError: vi.fn(),
}));
vi.mock("../db/client.ts", () => ({ pool: { query } }));
vi.mock("../deliveryStore.ts", () => ({ getEmailDeliveryMetricRows: rows }));
vi.mock("@ticket-live/runtime", () => ({
  createLogger: () => ({ error: loggerError }),
}));
vi.mock("../metrics.ts", () => ({
  renderEmailMetrics: () => "email metrics\n",
}));

import {
  createHealthController,
  getLiveness,
  getMetrics,
} from "./healthController.ts";

function createResponse() {
  return {
    code: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.code = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
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

describe("email health controller", () => {
  it("uses the injected worker readiness callback", async () => {
    query.mockResolvedValue({});
    let workerReady = true;
    const handler = createHealthController(() => workerReady);

    const ready = createResponse();
    await handler({} as never, ready as never);
    expect(ready.code).toBe(200);

    workerReady = false;
    const down = createResponse();
    await handler({} as never, down as never);
    expect(down.code).toBe(503);
  });

  it("reports liveness and returns the text outage response for metrics failures", async () => {
    const live = createResponse();
    getLiveness({} as never, live as never);
    expect(live.body).toEqual({ status: "ok" });

    rows.mockRejectedValueOnce(new Error("database unavailable"));
    const metrics = createResponse();
    await getMetrics({} as never, metrics as never);
    expect(metrics.code).toBe(503);
    expect(metrics.body).toBe("Email delivery metrics unavailable\n");
    expect(loggerError).toHaveBeenCalledOnce();
  });
});
