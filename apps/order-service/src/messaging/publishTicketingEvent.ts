import type { TicketingOrderConfirmedV1 } from "@ticket-live/contracts";
import {
  publishConfirmedMessage,
  getTraceContext,
  env,
  orderAmqpUrl,
} from "@ticket-live/runtime";
import { ticketingEventsExchangeName, ticketingEventsRoutingKey } from "@ticket-live/contracts";

export function publishTicketingEvent(event: TicketingOrderConfirmedV1): Promise<void> {
  const trace = getTraceContext();
  return publishConfirmedMessage({
    url: orderAmqpUrl,
    exchange: ticketingEventsExchangeName,
    routingKey: ticketingEventsRoutingKey,
    message: event,
    messageId: event.eventId,
    correlationId: event.correlationId,
    type: "order.confirmed.v1",
    autoDeclareTopology: env.RABBITMQ_AUTO_DECLARE_TOPOLOGY,
    headers: trace ? {
      traceparent: trace.traceparent,
      ...(trace.tracestate ? { tracestate: trace.tracestate } : {}),
    } : undefined,
  });
}
