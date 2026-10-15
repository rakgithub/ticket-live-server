import { Router } from "express";
import { pool } from "../db/client.ts";
import { elasticsearch } from "../search/client.ts";
import { renderHttpMetrics } from "../observability/metrics.ts";
import { exportOtlpMetrics } from "../observability/otlpMetricsExporter.ts";

const healthRoutes = Router();

healthRoutes.get("/health/live", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

healthRoutes.get("/health/ready", async (_req, res) => {
  const [postgres, elasticsearchStatus] = await Promise.allSettled([
    pool.query("SELECT 1"),
    elasticsearch.ping({}, { requestTimeout: 1_000 }),
  ]);
  const checks = {
    postgres: postgres.status === "fulfilled",
    elasticsearch: elasticsearchStatus.status === "fulfilled",
  };
  const ready = checks.postgres && checks.elasticsearch;

  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    checks,
  });
});

healthRoutes.get("/metrics", async (_req, res) => {
  let outbox: { pending: number; oldestAgeSeconds: number } | undefined;
  try {
    const result = await pool.query<{ pending: string; oldest_age_seconds: string | null }>(`
      SELECT
        SUM(pending)::text AS pending,
        GREATEST(0, EXTRACT(EPOCH FROM (NOW() - MIN(oldest_created_at))))::text AS oldest_age_seconds
      FROM (
        SELECT COUNT(*) AS pending, MIN(created_at) AS oldest_created_at
        FROM public.outbox_events
        WHERE processed_at IS NULL
        UNION ALL
        SELECT COUNT(*) AS pending, MIN(created_at) AS oldest_created_at
        FROM order_service.outbox_events
        WHERE processed_at IS NULL
      ) AS pending_outboxes
    `);
    outbox = {
      pending: Number(result.rows[0]?.pending ?? 0),
      oldestAgeSeconds: Number(result.rows[0]?.oldest_age_seconds ?? 0),
    };
  } catch {
    // Keep the scrape available when PostgreSQL is down; readiness reports the outage.
  }

  exportOtlpMetrics(outbox);
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.status(200).send(renderHttpMetrics(outbox));
});

export default healthRoutes;
