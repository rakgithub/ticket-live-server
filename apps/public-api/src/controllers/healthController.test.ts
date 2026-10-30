import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  eventReady: vi.fn(),
  orderReady: vi.fn(),
  ticketReady: vi.fn(),
  exportMetrics: vi.fn(),
  renderMetrics: vi.fn(() => "http\n"),
  renderChatMetrics: vi.fn(() => "chat\n"),
}));
vi.mock("../db/client.ts", () => ({ pool: { query: mocks.query } }));
vi.mock("../clients/eventServiceClient.ts", () => ({
  getEventServiceClient: () => ({ readiness: mocks.eventReady }),
}));
vi.mock("../clients/orderServiceClient.ts", () => ({
  getOrderServiceClient: () => ({ readiness: mocks.orderReady }),
}));
vi.mock("../clients/ticketingServiceClient.ts", () => ({
  getTicketingServiceClient: () => ({ readiness: mocks.ticketReady }),
}));
vi.mock("@ticket-live/runtime", () => ({
  exportOtlpMetrics: mocks.exportMetrics,
  renderHttpMetrics: mocks.renderMetrics,
}));
vi.mock("../chat/eventChatMetrics.ts", () => ({
  renderEventChatMetrics: mocks.renderChatMetrics,
}));

import { getLiveness, getMetrics, getReadiness } from "./healthController.ts";

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({});
  mocks.eventReady.mockResolvedValue({ status: "ready" });
  mocks.orderReady.mockResolvedValue(true);
  mocks.ticketReady.mockResolvedValue(true);
});

describe("public API health controller", () => {
  it("returns liveness and combines all readiness checks", async () => {
    const live = createResponse();
    getLiveness({} as never, live as never);
    expect(live.body).toEqual({ status: "ok" });

    const ready = createResponse();
    await getReadiness({} as never, ready as never);
    expect(ready.statusCode).toBe(200);
    expect(ready.body).toEqual({
      status: "ready",
      checks: {
        postgres: true,
        eventService: true,
        orderService: true,
        ticketingService: true,
      },
    });
    expect(mocks.query).toHaveBeenCalledWith("SELECT 1");
  });

  it("reports dependency failures and concatenates exported metrics", async () => {
    mocks.query.mockRejectedValueOnce(new Error("database unavailable"));
    const readiness = createResponse();
    await getReadiness({} as never, readiness as never);
    expect(readiness.statusCode).toBe(503);
    expect((readiness.body as { checks: { postgres: boolean } }).checks.postgres)
      .toBe(false);

    const metrics = createResponse();
    await getMetrics({} as never, metrics as never);
    expect(mocks.exportMetrics).toHaveBeenCalledOnce();
    expect(metrics.body).toBe("http\nchat\n");
    expect(metrics.headers["Content-Type"])
      .toBe("text/plain; version=0.0.4; charset=utf-8");
  });
});
