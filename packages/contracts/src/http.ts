import { z } from "zod";

export const CheckoutRequestSchema = z.object({
  eventId: z.uuid(),
  quantity: z.number().int().positive().max(10_000),
});

export const CheckoutIdempotencyKeySchema = z.string().trim().min(1).max(255);

/** Trusted API-to-Order handoff; user identity is carried separately in a header. */
export const InternalCheckoutRequestSchema = CheckoutRequestSchema.extend({
  customer: z.object({
    name: z.string().trim().min(1).max(255),
    email: z.email().trim().toLowerCase(),
  }).strict(),
}).strict();

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
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    totalAmountCents: z.number().int().nonnegative(),
    expiresAt: z.null(),
    createdAt: z.iso.datetime(),
  }),
  payment: z.object({
    id: z.uuid(),
    status: z.literal("succeeded"),
    gateway: z.literal("mock"),
  }),
}).superRefine((response, context) => {
  const expectedTotal = response.order.quantity * response.order.ticketPriceCents;
  if (!Number.isSafeInteger(expectedTotal) || response.order.totalAmountCents !== expectedTotal) {
    context.addIssue({
      code: "custom",
      path: ["order", "totalAmountCents"],
      message: "totalAmountCents must equal quantity multiplied by ticketPriceCents",
    });
  }
});

export const OrderStatusSchema = z.enum([
  "initiated",
  "held",
  "pending_payment",
  "confirmed",
  "cancelled",
  "expired",
  "reconciliation_required",
]);

export const PaymentStatusSchema = z.enum([
  "pending",
  "succeeded",
  "failed",
  "cancelled",
  "refunded",
]);

export const InternalPaymentChargeRequestSchema = z.object({
  orderId: z.uuid(),
  amountCents: z.number().int().nonnegative(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
});

export const InternalPaymentRecordSchema = z.object({
  id: z.uuid(),
  orderId: z.uuid(),
  status: PaymentStatusSchema,
  gateway: z.string().min(1),
});

export const OrderSummarySchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  event: z.object({
    name: z.string().min(1),
    location: z.string(),
    startsAt: z.iso.datetime(),
  }),
  quantity: z.number().int().positive(),
  status: OrderStatusSchema,
  ticketPriceCents: z.number().int().nonnegative(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  totalAmountCents: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime().nullable(),
  paymentStatus: PaymentStatusSchema.nullable(),
  createdAt: z.iso.datetime(),
});

export const OrderListResponseSchema = z.object({
  orders: z.array(OrderSummarySchema),
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

export const EventSearchCandidateSchema = z.object({
  id: z.uuid(),
  score: z.number().nullable(),
});

export const InternalEventSearchCandidatesResponseSchema = z.object({
  candidates: z.array(EventSearchCandidateSchema),
});

export const EventChatCardSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  descriptionPreview: z.string(),
  location: z.string(),
  startsAt: z.iso.datetime(),
  ticketPriceCents: z.number().int().nonnegative(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  minPeople: z.number().int().positive(),
  maxPeople: z.number().int().positive(),
  servesAlcohol: z.boolean(),
});

export const InternalEventChatCardsResponseSchema = z.object({
  cards: z.array(EventChatCardSchema),
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
export type InternalCheckoutRequest = z.infer<typeof InternalCheckoutRequestSchema>;
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;
export type InternalPaymentChargeRequest = z.infer<typeof InternalPaymentChargeRequestSchema>;
export type InternalPaymentRecord = z.infer<typeof InternalPaymentRecordSchema>;
export type OrderSummary = z.infer<typeof OrderSummarySchema>;
export type OrderListResponse = z.infer<typeof OrderListResponseSchema>;
export type InventoryHoldCreateRequest = z.infer<typeof InventoryHoldCreateRequestSchema>;
export type InventoryHoldIdempotencyKey = z.infer<typeof InventoryHoldIdempotencyKeySchema>;
export type InventoryHoldState = z.infer<typeof InventoryHoldStateSchema>;
export type InventoryHold = z.infer<typeof InventoryHoldSchema>;
export type InventoryHoldResponse = z.infer<typeof InventoryHoldResponseSchema>;
export type Event = z.infer<typeof EventSchema>;
export type EventSearchCandidate = z.infer<typeof EventSearchCandidateSchema>;
export type EventChatCard = z.infer<typeof EventChatCardSchema>;
export type EmailDeliveryStatus = z.infer<typeof EmailDeliveryStatusSchema>;
export type EmailDelivery = z.infer<typeof EmailDeliverySchema>;
