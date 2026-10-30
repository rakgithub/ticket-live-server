import type { Request, Response } from "express";
import { z } from "zod";
import { HttpErrorSchema, InternalPaymentChargeRequestSchema, InternalPaymentRecordSchema } from "@ticket-live/contracts";
import { cancelPayment, chargePayment, getPaymentByOrder } from "../services/paymentService.ts";

export async function postPayment(req: Request, res: Response): Promise<void> {
  const parsed = InternalPaymentChargeRequestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid payment request" }); return; }
  try {
    res.json(InternalPaymentRecordSchema.parse(await chargePayment(parsed.data)));
  } catch (error) {
    if (error instanceof Error && error.message.includes("different amount details")) {
      res.status(409).json(HttpErrorSchema.parse({ error: error.message })); return;
    }
    throw error;
  }
}

export async function getPayment(req: Request, res: Response): Promise<void> {
  const orderId = z.uuid().safeParse(req.params.orderId);
  if (!orderId.success) { res.status(400).json({ error: "Invalid order ID" }); return; }
  const payment = await getPaymentByOrder(orderId.data);
  if (!payment) { res.status(404).json({ error: "Payment not found" }); return; }
  res.json(InternalPaymentRecordSchema.parse(payment));
}

export async function postPaymentCancellation(req: Request, res: Response): Promise<void> {
  const orderId = z.uuid().safeParse(req.params.orderId);
  if (!orderId.success) { res.status(400).json({ error: "Invalid order ID" }); return; }
  const payment = await cancelPayment(orderId.data);
  if (!payment) { res.status(404).json({ error: "Payment not found" }); return; }
  res.json(InternalPaymentRecordSchema.parse(payment));
}
