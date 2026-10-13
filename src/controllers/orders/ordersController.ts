import type { Request, Response } from "express";
import {
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

  try {
    const checkoutResult = await checkout(req.auth.userId, parsedBody.data);
    const response = CheckoutResponseSchema.parse({
      ...checkoutResult,
      order: {
        ...checkoutResult.order,
        createdAt: checkoutResult.order.createdAt.toISOString(),
      },
    });
    logger.info("Checkout confirmed", {
      orderId: response.order.id,
      eventId: response.event.id,
      quantity: response.order.quantity,
    });
    res.status(201).json(response);
  } catch (error) {
    if (error instanceof CheckoutError) {
      logger.warn("Checkout did not complete", {
        eventId: parsedBody.data.eventId,
        statusCode: error.status,
      });
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
}
