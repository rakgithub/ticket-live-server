import type { Request, Response } from "express";
import { exportOtlpMetrics, renderHttpMetrics } from "@ticket-live/runtime";
import { pool } from "../db/client.ts";
export function getLiveness(_req: Request, res: Response): void { res.status(200).json({ status: "ok" }); }
export function createReadinessController(isConsumerReady: () => boolean) {
  return async function getReadiness(_req: Request, res: Response): Promise<void> {
    const postgres = await pool.query("SELECT 1 FROM ticketing_service.tickets LIMIT 0").then(() => true, () => false);
    const rabbitmq = isConsumerReady();
    const ready = postgres && rabbitmq;
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks: { postgres, rabbitmq } });
  };
}
export function getMetrics(_req: Request, res: Response): void {
  exportOtlpMetrics(undefined, "ticket-live-ticketing-service");
  res.type("text/plain; version=0.0.4; charset=utf-8").send(renderHttpMetrics());
}
