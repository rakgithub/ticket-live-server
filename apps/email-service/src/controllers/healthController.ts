import type { Request, Response } from "express";
import { createLogger } from "@ticket-live/runtime";
import { pool } from "../db/client.ts";
import { getEmailDeliveryMetricRows } from "../deliveryStore.ts";
import { renderEmailMetrics } from "../metrics.ts";

const logger = createLogger("ticket-live-email-service");

export function createHealthController(isWorkerReady: () => boolean) {
  return async function getReadiness(_req: Request, res: Response): Promise<void> {
    const postgres = await pool.query("SELECT 1").then(() => true, () => false);
    const checks = { postgres, rabbitmq: isWorkerReady() };
    const ready = checks.postgres && checks.rabbitmq;
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
  };
}

export function getLiveness(_req: Request, res: Response): void { res.status(200).json({ status: "ok" }); }

export async function getMetrics(_req: Request, res: Response): Promise<void> {
  try {
    const rows = await getEmailDeliveryMetricRows();
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.status(200).send(renderEmailMetrics(rows));
  } catch (error) {
    logger.error("Email delivery metrics query failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    res.status(503).type("text/plain").send("Email delivery metrics unavailable\n");
  }
}
