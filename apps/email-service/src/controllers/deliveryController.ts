import type { Request, Response } from "express";
import { z } from "zod";
import { EmailDeliveryResponseSchema } from "@ticket-live/contracts";
import { getDeliveryByNotificationKey } from "../deliveryStore.ts";

export async function getDelivery(req: Request, res: Response): Promise<void> {
  const key = z.string().trim().min(1).max(255).safeParse(req.params.notificationKey);
  if (!key.success) { res.status(400).json({ error: "Invalid notification key" }); return; }
  const delivery = await getDeliveryByNotificationKey(key.data);
  if (!delivery) { res.status(404).json({ error: "Delivery not found" }); return; }
  res.json(EmailDeliveryResponseSchema.parse({
    delivery: {
      ...delivery,
      providerAcceptedAt: delivery.providerAcceptedAt?.toISOString() ?? null,
      deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
      bouncedAt: delivery.bouncedAt?.toISOString() ?? null,
      failedAt: delivery.failedAt?.toISOString() ?? null,
      createdAt: delivery.createdAt.toISOString(),
      updatedAt: delivery.updatedAt.toISOString(),
    },
  }));
}
