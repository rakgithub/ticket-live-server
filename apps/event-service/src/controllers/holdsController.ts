import type { Request, Response } from "express";
import { z } from "zod";
import { InventoryHoldCreateRequestSchema, InventoryHoldResponseSchema } from "@ticket-live/contracts";
import { confirmInventoryHold, createInventoryHold, getInventoryHold, InventoryHoldError, releaseInventoryHold } from "../services/inventoryHoldsService.ts";

function serializeHold(hold: Awaited<ReturnType<typeof getInventoryHold>>) {
  return InventoryHoldResponseSchema.parse({ hold: { ...hold, currencyCode: hold.currencyCode.trim(), eventStartsAtSnapshot: hold.eventStartsAtSnapshot.toISOString(), expiresAt: hold.expiresAt.toISOString(), createdAt: hold.createdAt.toISOString(), updatedAt: hold.updatedAt.toISOString() } });
}
export async function createHold(req: Request, res: Response): Promise<void> {
  const eventId = z.uuid().safeParse(req.params.eventId); const body = InventoryHoldCreateRequestSchema.safeParse(req.body); const key = z.uuid().safeParse(req.header("idempotency-key"));
  if (!eventId.success || !body.success || !key.success || key.data !== body.data.orderId) { res.status(400).json({ error: "Invalid inventory hold request" }); return; }
  const result = await createInventoryHold({ eventId: eventId.data, ...body.data });
  res.status(result.created ? 201 : 200).json(serializeHold(result.hold));
}
export async function confirmHold(req: Request, res: Response): Promise<void> { await updateHold(req, res, confirmInventoryHold); }
export async function releaseHold(req: Request, res: Response): Promise<void> { await updateHold(req, res, releaseInventoryHold); }
async function updateHold(req: Request, res: Response, action: typeof confirmInventoryHold | typeof releaseInventoryHold): Promise<void> {
  const id = z.uuid().safeParse(req.params.holdId);
  if (!id.success) { res.status(400).json({ error: "Invalid inventory hold ID" }); return; }
  res.json(serializeHold(await action(id.data)));
}
export async function getHold(req: Request, res: Response): Promise<void> {
  const id = z.uuid().safeParse(req.params.holdId);
  if (!id.success) { res.status(400).json({ error: "Invalid inventory hold ID" }); return; }
  res.json(serializeHold(await getInventoryHold(id.data)));
}
export { InventoryHoldError };
