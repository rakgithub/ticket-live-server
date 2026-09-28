import type { Request, Response } from "express";
import { z } from "zod";
import { CheckoutError, checkout } from "../../services/orders/checkoutService.ts";

const checkoutBodySchema = z.object({
  eventId: z.uuid(),
  quantity: z.number().int().positive().max(10_000),
});

export async function postCheckout(req: Request, res: Response): Promise<void> {
  const parsedBody = checkoutBodySchema.safeParse(req.body);
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
    res.status(201).json(checkoutResult);
  } catch (error) {
    if (error instanceof CheckoutError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
}
