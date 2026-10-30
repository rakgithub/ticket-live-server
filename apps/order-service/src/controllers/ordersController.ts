import type { Request, Response } from "express";
import { z } from "zod";
import {
  CheckoutIdempotencyKeySchema,
  CheckoutResponseSchema,
  HttpErrorSchema,
  InternalCheckoutRequestSchema,
} from "@ticket-live/contracts";
import { CheckoutError, checkout } from "../services/orders/checkoutService.ts";
import { listOrdersForUser } from "../services/orders/listOrdersService.ts";

export async function getOrders(req: Request, res: Response): Promise<void> {
  const userId = z.uuid().safeParse(req.header("x-actor-user-id"));
  if (!userId.success) {
    res.status(400).json({ error: "Invalid actor user ID" });
    return;
  }
  res.json(await listOrdersForUser(userId.data));
}

export async function postCheckout(req: Request, res: Response): Promise<void> {
  const body = InternalCheckoutRequestSchema.safeParse(req.body);
  const userId = z.uuid().safeParse(req.header("x-actor-user-id"));
  const idempotencyKey = CheckoutIdempotencyKeySchema.safeParse(req.header("Idempotency-Key"));
  if (!body.success || !userId.success || !idempotencyKey.success) {
    res.status(400).json({ error: "Invalid internal checkout request" });
    return;
  }

  try {
    const result = await checkout(
      userId.data,
      { eventId: body.data.eventId, quantity: body.data.quantity },
      idempotencyKey.data,
      body.data.customer,
    );
    res.status(201).json(CheckoutResponseSchema.parse(result));
  } catch (error) {
    if (error instanceof CheckoutError) {
      res.status(error.status).json(HttpErrorSchema.parse({ error: error.message }));
      return;
    }
    throw error;
  }
}
