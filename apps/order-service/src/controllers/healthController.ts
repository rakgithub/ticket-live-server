import type { Request, Response } from "express";
import { exportOtlpMetrics, renderHttpMetrics } from "@ticket-live/runtime";
import { pool } from "../db/client.ts";
import { getPaymentHoldMismatchTotal } from "../services/orders/reconcileInventory.ts";

export function getLiveness(_req: Request, res: Response): void {
  res.status(200).json({ status: "ok" });
}

export async function getReadiness(_req: Request, res: Response): Promise<void> {
  const postgres = await pool.query("SELECT 1").then(() => true, () => false);
  res.status(postgres ? 200 : 503).json({
    status: postgres ? "ready" : "not_ready",
    checks: { postgres },
  });
}

export async function getMetrics(_req: Request, res: Response): Promise<void> {
  let outbox: { pending: number; oldestAgeSeconds: number } | undefined;
  let orders: { unresolved: number; oldestUnresolvedAgeSeconds: number } | undefined;
  try {
    const result = await pool.query<{ pending: string; oldest_age_seconds: string | null }>(`
      SELECT COUNT(*)::text AS pending,
        GREATEST(0, EXTRACT(EPOCH FROM (NOW() - MIN(created_at))))::text AS oldest_age_seconds
      FROM order_service.outbox_events
      WHERE processed_at IS NULL
    `);
    outbox = {
      pending: Number(result.rows[0]?.pending ?? 0),
      oldestAgeSeconds: Number(result.rows[0]?.oldest_age_seconds ?? 0),
    };
  } catch {
    // Leave HTTP metrics scrapeable during database outages.
  }
  try {
    const result = await pool.query<{ unresolved: string; oldest_age_seconds: string | null }>(`
      SELECT COUNT(*)::text AS unresolved,
        GREATEST(0, EXTRACT(EPOCH FROM (NOW() - MIN(updated_at))))::text AS oldest_age_seconds
      FROM order_service.orders
      WHERE status IN ('initiated', 'held', 'pending_payment', 'reconciliation_required')
    `);
    orders = {
      unresolved: Number(result.rows[0]?.unresolved ?? 0),
      oldestUnresolvedAgeSeconds: Number(result.rows[0]?.oldest_age_seconds ?? 0),
    };
  } catch {
    // Leave HTTP metrics scrapeable during database outages.
  }
  exportOtlpMetrics(outbox, "ticket-live-order-service");
  res.type("text/plain; version=0.0.4; charset=utf-8").send(renderHttpMetrics(outbox, {
    ...(orders ? { orders } : {}),
    paymentHoldMismatchTotal: getPaymentHoldMismatchTotal(),
  }));
}
