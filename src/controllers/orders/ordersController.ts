import type { Request, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { CheckoutIdempotencyKeySchema, CheckoutRequestSchema } from "@ticket-live/contracts";
import { db } from "../../db/client.ts";
import { usersTable } from "../../db/schema/users.ts";
import { getOrderServiceClient, OrderServiceError } from "../../services/orders/orderServiceClient.ts";
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
    const [customer] = await db
      .select({ name: usersTable.displayName, email: usersTable.email })
      .from(usersTable)
      .where(and(eq(usersTable.id, req.auth.userId), isNull(usersTable.deletedAt)))
      .limit(1);
    if (!customer) {
      res.status(404).json({ error: "Customer account is not available" });
      return;
    }
    const response = await getOrderServiceClient().checkout(
      req.auth.userId,
      parsedBody.data,
      customer,
      parsedIdempotencyKey.data,
    );
    logger.info("Checkout confirmed", {
      orderId: response.order.id,
      eventId: response.event.id,
      quantity: response.order.quantity,
    });
    res.status(201).json(response);
  } catch (error) {
    if (error instanceof OrderServiceError) {
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
