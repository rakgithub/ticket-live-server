import type { Request, Response } from "express";
import { exportOtlpMetrics, renderHttpMetrics } from "@ticket-live/runtime";
import { pool } from "../db/client.ts";

export function getLiveness(_req: Request, res: Response): void { res.status(200).json({ status: "ok" }); }
export async function getReadiness(_req: Request, res: Response): Promise<void> {
  const postgres = await pool.query("SELECT 1").then(() => true, () => false);
  res.status(postgres ? 200 : 503).json({ status: postgres ? "ready" : "not_ready", checks: { postgres } });
}
export function getMetrics(_req: Request, res: Response): void {
  exportOtlpMetrics(undefined, "ticket-live-payment-service");
  res.type("text/plain; version=0.0.4; charset=utf-8").send(renderHttpMetrics());
}
