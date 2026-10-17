import { z } from "zod";

export const OrderConfirmedDataSchema = z.object({
  orderId: z.uuid(),
  customer: z.object({
    name: z.string().min(1),
    email: z.email(),
  }),
  event: z.object({
    id: z.uuid(),
    name: z.string().min(1),
    location: z.string().min(1),
    startsAt: z.iso.datetime(),
  }),
  quantity: z.number().int().positive(),
  ticketPriceCents: z.number().int().nonnegative(),
  totalAmountCents: z.number().int().nonnegative(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
}).superRefine((data, context) => {
  const expectedTotal = data.quantity * data.ticketPriceCents;
  if (!Number.isSafeInteger(expectedTotal) || data.totalAmountCents !== expectedTotal) {
    context.addIssue({
      code: "custom",
      path: ["totalAmountCents"],
      message: "totalAmountCents must equal quantity multiplied by ticketPriceCents",
    });
  }
});

export const OrderConfirmedV1Schema = z.object({
  eventId: z.uuid(),
  eventType: z.literal("order.confirmed"),
  schemaVersion: z.literal(1),
  aggregateId: z.uuid(),
  occurredAt: z.iso.datetime(),
  correlationId: z.uuid(),
  data: OrderConfirmedDataSchema,
});

/** Minimal projection of order.confirmed for Ticketing; customer email and payment amounts stay in Order/Email. */
export const TicketingOrderConfirmedV1Schema = z.object({
  eventId: z.uuid(),
  eventType: z.literal("order.confirmed"),
  schemaVersion: z.literal(1),
  aggregateId: z.uuid(),
  occurredAt: z.iso.datetime(),
  correlationId: z.uuid(),
  data: z.object({
    orderId: z.uuid(),
    customer: z.object({ name: z.string().min(1) }),
    event: z.object({
      id: z.uuid(),
      name: z.string().min(1),
      location: z.string().min(1),
      startsAt: z.iso.datetime(),
    }),
    quantity: z.number().int().positive(),
  }),
}).superRefine((message, context) => {
  if (message.aggregateId !== message.data.orderId) {
    context.addIssue({ code: "custom", path: ["aggregateId"], message: "Order ID must match the aggregate ID" });
  }
});

export const EventTicketInvalidationV1Schema = z.object({
  eventId: z.uuid(),
  eventType: z.enum(["event.cancelled", "event.deleted"]),
  schemaVersion: z.literal(1),
  aggregateId: z.uuid(),
  occurredAt: z.iso.datetime(),
  correlationId: z.uuid(),
  data: z.object({
    eventId: z.uuid(),
    version: z.number().int().positive(),
  }),
}).superRefine((message, context) => {
  if (message.data.eventId !== message.aggregateId) {
    context.addIssue({ code: "custom", path: ["aggregateId"], message: "Event IDs must match the aggregate ID" });
  }
});

export const TicketingEventV1Schema = z.union([
  TicketingOrderConfirmedV1Schema,
  EventTicketInvalidationV1Schema,
]);

/** Accepts messages already persisted in RabbitMQ before the v1 cutover. */
export const LegacyOrderConfirmedMessageSchema = z.object({
  eventId: z.uuid(),
  eventType: z.literal("order.confirmed"),
  occurredAt: z.iso.datetime(),
  data: OrderConfirmedDataSchema,
}).strict();

export function parseOrderConfirmedMessage(value: unknown): OrderConfirmedV1 {
  const current = OrderConfirmedV1Schema.safeParse(value);
  if (current.success) return current.data;

  const legacy = LegacyOrderConfirmedMessageSchema.parse(value);
  return OrderConfirmedV1Schema.parse({
    ...legacy,
    schemaVersion: 1,
    aggregateId: legacy.data.orderId,
    correlationId: legacy.eventId,
  });
}

/**
 * Unknown fields are stripped so older consumers can safely read additive
 * optional fields introduced within v1.
 */
export const EmailSendV1Schema = z.object({
  commandId: z.uuid(),
  commandType: z.literal("email.send"),
  schemaVersion: z.literal(1),
  notificationKey: z.string().min(1).max(255),
  templateId: z.string().min(1),
  recipient: z.email(),
  data: z.object({
    orderId: z.uuid(),
    customerName: z.string().min(1),
    eventName: z.string().min(1),
    eventLocation: z.string().min(1),
    eventStartsAt: z.iso.datetime(),
    quantity: z.number().int().positive(),
    totalAmountCents: z.number().int().nonnegative(),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    ticketsUrl: z.url().optional(),
  }),
});

export type OrderConfirmedData = z.infer<typeof OrderConfirmedDataSchema>;
export type OrderConfirmedV1 = z.infer<typeof OrderConfirmedV1Schema>;
export type TicketingOrderConfirmedV1 = z.infer<typeof TicketingOrderConfirmedV1Schema>;
export type EventTicketInvalidationV1 = z.infer<typeof EventTicketInvalidationV1Schema>;
export type TicketingEventV1 = z.infer<typeof TicketingEventV1Schema>;
export type EmailSendV1 = z.infer<typeof EmailSendV1Schema>;
