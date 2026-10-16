import { describe, expect, it } from "vitest";
import {
  buildOrderConfirmationEmailCommand,
  parseEmailReplayArgs,
} from "./orderConfirmation.ts";

const outboxEvent = {
  id: "3d05f1b6-15eb-4cc1-b4bd-00e18b936d5f",
  aggregateId: "e637ca0a-0b5f-42ce-a070-bfa9c05aaf1a",
  payload: {
    orderId: "e637ca0a-0b5f-42ce-a070-bfa9c05aaf1a",
    customer: { name: "Example Customer", email: "customer@example.com" },
    event: {
      id: "1dc646c7-bd99-4bd5-9537-df2c61d23e96",
      name: "Example Concert",
      location: "Berlin",
      startsAt: "2026-11-13T19:00:00Z",
    },
    quantity: 2,
    ticketPriceCents: 4_000,
    totalAmountCents: 8_000,
    currencyCode: "EUR",
    __telemetry: { correlationId: "redacted-on-purpose" },
  },
};

describe("Order confirmation Email replay", () => {
  it("builds a command with the original command ID and notification key", () => {
    expect(buildOrderConfirmationEmailCommand(outboxEvent)).toEqual({
      commandId: outboxEvent.id,
      commandType: "email.send",
      schemaVersion: 1,
      notificationKey: `order-confirmation:${outboxEvent.aggregateId}`,
      templateId: "order-confirmation-v1",
      recipient: "customer@example.com",
      data: {
        orderId: outboxEvent.aggregateId,
        customerName: "Example Customer",
        eventName: "Example Concert",
        eventLocation: "Berlin",
        eventStartsAt: "2026-11-13T19:00:00Z",
        quantity: 2,
        totalAmountCents: 8_000,
        currencyCode: "EUR",
      },
    });
    expect(JSON.stringify(buildOrderConfirmationEmailCommand(outboxEvent))).not.toContain("__telemetry");
  });

  it("rejects a payload whose order ID does not match the outbox aggregate", () => {
    expect(() => buildOrderConfirmationEmailCommand({
      ...outboxEvent,
      aggregateId: "2d7a8b4d-3c38-4d4d-91a9-6d1b80cf0bd1",
    })).toThrow("does not match");
  });

  it("limits replay input to one order and requires an operator and reason", () => {
    expect(parseEmailReplayArgs([
      "--order-id", outboxEvent.aggregateId,
      "--requested-by", "on-call",
      "--reason", "INC-123",
      "--apply",
    ])).toEqual({
      orderId: outboxEvent.aggregateId,
      requestedBy: "on-call",
      reason: "INC-123",
      apply: true,
    });
    expect(() => parseEmailReplayArgs(["--order-id", outboxEvent.aggregateId])).toThrow("--requested-by");
    expect(() => parseEmailReplayArgs([
      "--order-id", outboxEvent.aggregateId,
      "--requested-by", "on-call",
      "--reason", "INC-123",
      "--order-id", outboxEvent.aggregateId,
    ])).toThrow("may only be specified once");
  });
});
