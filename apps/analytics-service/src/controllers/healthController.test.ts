import { describe, expect, it, vi } from "vitest";

const { exportMetrics, renderMetrics } = vi.hoisted(() => ({
  exportMetrics: vi.fn(),
  renderMetrics: vi.fn(() => "metrics\n"),
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

describe("analytics health controller", () => {
  it("returns the fixed health responses and exports metrics", () => {
    const live = createResponse();
    getLiveness({} as never, live as never);
    expect(live.body).toEqual({ status: "ok" });

    const ready = createResponse();
    getReadiness({} as never, ready as never);
    expect(ready.body).toEqual({ status: "ready" });

    const metrics = createResponse();
    getMetrics({} as never, metrics as never);
    expect(exportMetrics).toHaveBeenCalledWith(
      undefined,
      "ticket-live-analytics-service",
    );
    expect(metrics.body).toBe("metrics\n");
    expect(metrics.contentType).toContain("text/plain");
  });
});
