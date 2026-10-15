import { z } from "zod";

export const CheckoutRequestSchema = z.object({
  eventId: z.uuid(),
  quantity: z.number().int().positive().max(10_000),
});

export const CheckoutIdempotencyKeySchema = z.string().trim().min(1).max(255);

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

export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;
export type CheckoutIdempotencyKey = z.infer<typeof CheckoutIdempotencyKeySchema>;
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;
