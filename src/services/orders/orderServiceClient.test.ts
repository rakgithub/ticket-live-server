import { afterEach, describe, expect, it, vi } from "vitest";
import { OrderServiceClient, OrderServiceError } from "./orderServiceClient.ts";

const checkoutResponse = {
  event: { id: "11111111-1111-4111-8111-111111111111", name: "Concert" },
  order: {
    id: "22222222-2222-4222-8222-222222222222",
    eventId: "11111111-1111-4111-8111-111111111111",
    quantity: 2,
    status: "confirmed",
    ticketPriceCents: 1_500,
    currencyCode: "EUR",
    totalAmountCents: 3_000,
    expiresAt: null,
    createdAt: "2026-10-16T12:00:00.000Z",
  },
  payment: {
    id: "33333333-3333-4333-8333-333333333333",
    status: "succeeded",
    gateway: "mock",
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("OrderServiceClient", () => {
  it("sends the actor, idempotency key, and minimized customer snapshot", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(checkoutResponse, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new OrderServiceClient({ serviceToken: "test-service-token-123456789012345678" }).checkout(
      "44444444-4444-4444-8444-444444444444",
      { eventId: "11111111-1111-4111-8111-111111111111", quantity: 2 },
      { name: "Example Customer", email: "customer@example.com" },
      "checkout-key-1",
    );

    expect(result).toEqual(checkoutResponse);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    expect(url).toContain("/internal/orders/checkout");
    expect(options?.headers).toMatchObject({
      "x-actor-user-id": "44444444-4444-4444-8444-444444444444",
      "idempotency-key": "checkout-key-1",
    });
    expect(String(options?.headers && (options.headers as Record<string, string>).authorization))
      .toMatch(/^Bearer .{32,}$/);
    expect(JSON.parse(String(options?.body))).toEqual({
      eventId: "11111111-1111-4111-8111-111111111111",
      quantity: 2,
      customer: { name: "Example Customer", email: "customer@example.com" },
    });
  });

  it("preserves Order errors and does not retry a lost response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ error: "capacity exhausted" }, { status: 409 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(new OrderServiceClient({ serviceToken: "test-service-token-123456789012345678" }).checkout(
      "44444444-4444-4444-8444-444444444444",
      { eventId: "11111111-1111-4111-8111-111111111111", quantity: 2 },
      { name: "Example Customer", email: "customer@example.com" },
      "checkout-key-1",
    )).rejects.toMatchObject({ name: "OrderServiceError", status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockRejectedValueOnce(new Error("connection dropped"));
    await expect(new OrderServiceClient({ serviceToken: "test-service-token-123456789012345678" }).checkout(
      "44444444-4444-4444-8444-444444444444",
      { eventId: "11111111-1111-4111-8111-111111111111", quantity: 2 },
      { name: "Example Customer", email: "customer@example.com" },
      "checkout-key-1",
    )).rejects.toBeInstanceOf(OrderServiceError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
