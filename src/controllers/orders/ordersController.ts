import type { Request, Response } from "express";
import {
  CheckoutIdempotencyKeySchema,
  CheckoutRequestSchema,
  CheckoutResponseSchema,
} from "@ticket-live/contracts";
import { CheckoutError, checkout } from "../../services/orders/checkoutService.ts";
import { createLogger } from "../../observability/logger.ts";

const logger = createLogger("ticket-live-public-api");

export async function postCheckout(req: Request, res: Response): Promise<void> {
  const parsedBody = CheckoutRequestSchema.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: "Invalid checkout details" });
    return;
  }

  if (!req.auth) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const parsedIdempotencyKey = CheckoutIdempotencyKeySchema.safeParse(
    req.header("Idempotency-Key"),
  );
  if (!parsedIdempotencyKey.success) {
    res.status(400).json({ error: "A valid Idempotency-Key header is required" });
    return;
  }

  try {
    const checkoutResult = await checkout(
      req.auth.userId,
      parsedBody.data,
      parsedIdempotencyKey.data,
    );
    const response = CheckoutResponseSchema.parse(checkoutResult);
    logger.info("Checkout confirmed", {
      orderId: response.order.id,
      eventId: response.event.id,
      quantity: response.order.quantity,
    });
    res.status(201).json(response);
  } catch (error) {
    if (error instanceof CheckoutError) {
      const logCheckoutError = error.status >= 500 ? logger.error : logger.warn;
      logCheckoutError("Checkout did not complete", {
        eventId: parsedBody.data.eventId,
        statusCode: error.status,
      });
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
}
