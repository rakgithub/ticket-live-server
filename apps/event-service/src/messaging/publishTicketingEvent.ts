import {
  EventTicketInvalidationV1Schema,
  ticketingEventsExchangeName,
  ticketingEventsRoutingKey,
  type EventTicketInvalidationV1,
} from "@ticket-live/contracts";
import { env, eventAmqpUrl, publishConfirmedMessage } from "@ticket-live/runtime";

type EventOutboxRow = {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

export function buildEventTicketInvalidation(row: EventOutboxRow): EventTicketInvalidationV1 {
  if (row.eventType !== "event.cancelled" && row.eventType !== "event.deleted") {
    throw new Error("Only cancelled or deleted events can invalidate tickets");
  }
  const payload = { ...row.payload };
  const telemetry = payload.__telemetry;
  delete payload.__telemetry;
  const version = typeof payload.version === "number" && Number.isInteger(payload.version) && payload.version > 0
    ? payload.version
    : 1;
  const correlationId = typeof telemetry === "object" && telemetry !== null &&
    typeof (telemetry as Record<string, unknown>).correlationId === "string"
    ? (telemetry as Record<string, unknown>).correlationId as string
    : row.id;

  return EventTicketInvalidationV1Schema.parse({
    eventId: row.id,
    eventType: row.eventType,
    schemaVersion: 1,
    aggregateId: row.aggregateId,
    occurredAt: row.createdAt.toISOString(),
    correlationId,
    data: { eventId: row.aggregateId, version },
  });
}

export function eventTicketInvalidationTraceHeaders(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const telemetry = payload.__telemetry;
  if (typeof telemetry !== "object" || telemetry === null) return undefined;
  const fields = telemetry as Record<string, unknown>;
  if (typeof fields.traceparent !== "string") return undefined;
  return {
    traceparent: fields.traceparent,
    ...(typeof fields.tracestate === "string" ? { tracestate: fields.tracestate } : {}),
  };
}

export function publishEventTicketInvalidation(
  event: EventTicketInvalidationV1,
  headers?: Record<string, unknown>,
): Promise<void> {
  return publishConfirmedMessage({
    url: eventAmqpUrl,
    exchange: ticketingEventsExchangeName,
    routingKey: ticketingEventsRoutingKey,
    message: event,
    messageId: event.eventId,
    correlationId: event.correlationId,
    type: `${event.eventType}.v1`,
    autoDeclareTopology: env.RABBITMQ_AUTO_DECLARE_TOPOLOGY,
    headers,
  });
}
