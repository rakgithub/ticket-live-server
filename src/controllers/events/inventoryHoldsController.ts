import type { Request, Response } from "express";
import { z } from "zod";
import type { InventoryHold } from "../../db/schema/inventoryHolds.ts";
import { createLogger } from "../../observability/logger.ts";
import {
  InventoryHoldCreateRequestSchema,
  InventoryHoldIdempotencyKeySchema,
  InventoryHoldResponseSchema,
} from "@ticket-live/contracts";
import {
  confirmInventoryHold,
  createInventoryHold,
  getInventoryHold,
  InventoryHoldError,
  releaseInventoryHold,
} from "../../services/events/inventoryHoldsService.ts";

const logger = createLogger("ticket-live-public-api");

function serializeHold(hold: InventoryHold) {
  return InventoryHoldResponseSchema.parse({
    hold: {
      ...hold,
      currencyCode: hold.currencyCode.trim(),
      eventStartsAtSnapshot: hold.eventStartsAtSnapshot.toISOString(),
      expiresAt: hold.expiresAt.toISOString(),
      createdAt: hold.createdAt.toISOString(),
      updatedAt: hold.updatedAt.toISOString(),
    },
  });
}

function sendInventoryError(error: unknown, res: Response): boolean {
  if (!(error instanceof InventoryHoldError)) return false;
  res.status(error.status).json({ error: error.message });
  return true;
}

export async function postInventoryHold(req: Request, res: Response): Promise<void> {
  const eventId = z.uuid().safeParse(req.params.eventId);
  const parsedBody = InventoryHoldCreateRequestSchema.safeParse(req.body);
  const idempotencyKey = InventoryHoldIdempotencyKeySchema.safeParse(
    req.header("Idempotency-Key"),
  );

  if (
    !eventId.success || !parsedBody.success || !idempotencyKey.success ||
    parsedBody.data.orderId !== idempotencyKey.data
  ) {
    res.status(400).json({ error: "Invalid inventory hold request" });
    return;
  }

  try {
    const result = await createInventoryHold({
      eventId: eventId.data,
      ...parsedBody.data,
    });
    const response = serializeHold(result.hold);
    logger.info("Inventory hold created or reused", {
      eventId: response.hold.eventId,
      holdId: response.hold.holdId,
      orderId: response.hold.orderId,
      quantity: response.hold.quantity,
      created: result.created,
    });
    res.status(result.created ? 201 : 200).json(response);
  } catch (error) {
    if (sendInventoryError(error, res)) return;
    throw error;
  }
}

export async function postConfirmInventoryHold(
  req: Request,
  res: Response,
): Promise<void> {
  const holdId = z.uuid().safeParse(req.params.holdId);
  if (!holdId.success) {
    res.status(400).json({ error: "Invalid inventory hold ID" });
    return;
  }

  try {
    const hold = await confirmInventoryHold(holdId.data);
    res.status(200).json(serializeHold(hold));
  } catch (error) {
    if (sendInventoryError(error, res)) return;
    throw error;
  }
}

export async function postReleaseInventoryHold(
  req: Request,
  res: Response,
): Promise<void> {
  const holdId = z.uuid().safeParse(req.params.holdId);
  if (!holdId.success) {
    res.status(400).json({ error: "Invalid inventory hold ID" });
    return;
  }

  try {
    const hold = await releaseInventoryHold(holdId.data);
    res.status(200).json(serializeHold(hold));
  } catch (error) {
    if (sendInventoryError(error, res)) return;
    throw error;
  }
}

export async function getInventoryHoldById(
  req: Request,
  res: Response,
): Promise<void> {
  const holdId = z.uuid().safeParse(req.params.holdId);
  if (!holdId.success) {
    res.status(400).json({ error: "Invalid inventory hold ID" });
    return;
  }

  try {
    const hold = await getInventoryHold(holdId.data);
    res.status(200).json(serializeHold(hold));
  } catch (error) {
    if (sendInventoryError(error, res)) return;
    throw error;
  }
}
