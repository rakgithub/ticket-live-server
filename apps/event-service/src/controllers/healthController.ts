import type { Request, Response } from "express";
import { exportOtlpMetrics, renderHttpMetrics } from "@ticket-live/runtime";
import { pool } from "../db/client.ts";
import { elasticsearch } from "../search/client.ts";
import { getInventoryHoldCounters } from "../services/inventoryHoldsService.ts";

export function getLiveness(_req: Request, res: Response): void { res.status(200).json({ status: "ok" }); }
export async function getReadiness(_req: Request, res: Response): Promise<void> {
  const [postgres, elasticsearchStatus] = await Promise.allSettled([pool.query("SELECT 1"), elasticsearch.ping({}, { requestTimeout: 1_000 })]);
  const checks = { postgres: postgres.status === "fulfilled", elasticsearch: elasticsearchStatus.status === "fulfilled" };
  const ready = checks.postgres && checks.elasticsearch;
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
}
export async function getMetrics(_req: Request, res: Response): Promise<void> {
  let outbox: { pending: number; oldestAgeSeconds: number } | undefined;
  let holds: { active: number; oldestAgeSeconds: number } | undefined;
  try {
    const result = await pool.query<{ pending: string; oldest_age_seconds: string | null }>(`SELECT COUNT(*)::text AS pending, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - MIN(created_at))))::text AS oldest_age_seconds FROM event_service.outbox_events WHERE processed_at IS NULL`);
    outbox = { pending: Number(result.rows[0]?.pending ?? 0), oldestAgeSeconds: Number(result.rows[0]?.oldest_age_seconds ?? 0) };
    const holdResult = await pool.query<{ active: string; oldest_age_seconds: string | null }>(`SELECT COUNT(*)::text AS active, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - MIN(created_at))))::text AS oldest_age_seconds FROM event_service.inventory_holds WHERE state = 'active'`);
    holds = { active: Number(holdResult.rows[0]?.active ?? 0), oldestAgeSeconds: Number(holdResult.rows[0]?.oldest_age_seconds ?? 0) };
  } catch {
    // HTTP metrics remain available while readiness reports a database outage.
  }
  exportOtlpMetrics(outbox, "ticket-live-event-service");
  const counters = getInventoryHoldCounters();
  res.type("text/plain; version=0.0.4; charset=utf-8").send(renderHttpMetrics(outbox, { ...(holds ? { holds: { ...holds, capacityConflictsTotal: counters.capacityConflictsTotal, expiredTotal: counters.expiredHoldsTotal } } : {}) }));
}
