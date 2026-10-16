import { z } from "zod";

const OrderConfirmationDataSchema = z.object({
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
});

export const OrderConfirmedV1Schema = z.object({
  eventId: z.uuid(),
  eventType: z.literal("order.confirmed"),
  schemaVersion: z.literal(1),
  aggregateId: z.uuid(),
  occurredAt: z.iso.datetime(),
  correlationId: z.uuid(),
  data: OrderConfirmationDataSchema,
});

/** Accepts messages already persisted in RabbitMQ before the v1 cutover. */
export const LegacyOrderConfirmedMessageSchema = z.object({
  eventId: z.uuid(),
  eventType: z.literal("order.confirmed"),
  occurredAt: z.iso.datetime(),
  data: OrderConfirmationDataSchema,
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

export const EmailSendV1Schema = z.object({
  commandId: z.uuid(),
  commandType: z.literal("email.send"),
  schemaVersion: z.literal(1),
  notificationKey: z.string().min(1),
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
  }).strict(),
}).strict();

export type OrderConfirmedV1 = z.infer<typeof OrderConfirmedV1Schema>;
export type EmailSendV1 = z.infer<typeof EmailSendV1Schema>;
