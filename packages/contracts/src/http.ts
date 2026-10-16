import { z } from "zod";

export const CheckoutRequestSchema = z.object({
  eventId: z.uuid(),
  quantity: z.number().int().positive().max(10_000),
});

export const CheckoutIdempotencyKeySchema = z.string().trim().min(1).max(255);

export const InventoryHoldCreateRequestSchema = z.object({
  orderId: z.uuid(),
  quantity: z.number().int().positive().max(10_000),
});

export const InventoryHoldIdempotencyKeySchema = z.uuid();

export const InventoryHoldStateSchema = z.enum([
  "active",
  "confirmed",
  "released",
  "expired",
]);

export const InventoryHoldSchema = z.object({
  holdId: z.uuid(),
  orderId: z.uuid(),
  eventId: z.uuid(),
  eventNameSnapshot: z.string().min(1),
  eventLocationSnapshot: z.string(),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  eventStartsAtSnapshot: z.iso.datetime(),
  state: InventoryHoldStateSchema,
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const InventoryHoldResponseSchema = z.object({
  hold: InventoryHoldSchema,
});

/** Current POST /orders/checkout 201 response; keep aligned with the public API. */
export const CheckoutResponseSchema = z.object({
  event: z.object({
    id: z.uuid(),
    name: z.string().min(1),
  }),
  order: z.object({
    id: z.uuid(),
    eventId: z.uuid(),
    quantity: z.number().int().positive(),
    status: z.literal("confirmed"),
    ticketPriceCents: z.number().int().nonnegative(),
    currencyCode: z.string().length(3),
    totalAmountCents: z.number().int().nonnegative(),
    expiresAt: z.null(),
    createdAt: z.iso.datetime(),
  }),
  payment: z.object({
    id: z.uuid(),
    status: z.literal("succeeded"),
    gateway: z.literal("mock"),
  }),
});

export const HttpErrorSchema = z.object({ error: z.string().min(1) });

export const EventSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  description: z.string().min(1),
  location: z.string().min(1),
  minPeople: z.number().int().positive(),
  maxPeople: z.number().int().positive(),
  reservedQuantity: z.number().int().nonnegative(),
  ticketPriceCents: z.number().int().nonnegative(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  servesAlcohol: z.boolean(),
  isCancelled: z.boolean(),
  userId: z.uuid(),
  startsAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const EventListResponseSchema = z.object({ events: z.array(EventSchema) });
export const EventCreateResponseSchema = z.object({ event: EventSchema });
export const EventSearchResponseSchema = z.object({
  events: z.array(EventSchema.extend({ score: z.number().nullable() })),
});

export const EmailDeliveryStatusSchema = z.enum([
  "queued",
  "sending",
  "accepted_by_provider",
  "delivered",
  "bounced",
  "failed",
  "simulated",
]);

export const EmailDeliverySchema = z.object({
  id: z.uuid(),
  notificationKey: z.string().min(1),
  orderId: z.uuid(),
  status: EmailDeliveryStatusSchema,
  providerName: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  providerAcceptedAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  bouncedAt: z.iso.datetime().nullable(),
  failedAt: z.iso.datetime().nullable(),
  attempts: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const EmailDeliveryResponseSchema = z.object({ delivery: EmailDeliverySchema });

export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;
export type CheckoutIdempotencyKey = z.infer<typeof CheckoutIdempotencyKeySchema>;
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;
export type InventoryHoldCreateRequest = z.infer<typeof InventoryHoldCreateRequestSchema>;
export type InventoryHoldIdempotencyKey = z.infer<typeof InventoryHoldIdempotencyKeySchema>;
export type InventoryHoldState = z.infer<typeof InventoryHoldStateSchema>;
export type InventoryHold = z.infer<typeof InventoryHoldSchema>;
export type InventoryHoldResponse = z.infer<typeof InventoryHoldResponseSchema>;
export type Event = z.infer<typeof EventSchema>;
export type EmailDeliveryStatus = z.infer<typeof EmailDeliveryStatusSchema>;
export type EmailDelivery = z.infer<typeof EmailDeliverySchema>;
