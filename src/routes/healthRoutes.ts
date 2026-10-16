import { Router } from "express";
import { pool } from "../db/client.ts";
import { getEventServiceClient } from "../services/events/eventServiceClient.ts";
import { renderHttpMetrics } from "../observability/metrics.ts";
import { exportOtlpMetrics } from "../observability/otlpMetricsExporter.ts";
import { getOrderServiceClient } from "../services/orders/orderServiceClient.ts";

const healthRoutes = Router();

healthRoutes.get("/health/live", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

healthRoutes.get("/health/ready", async (_req, res) => {
  const [postgres, eventService, orderService] = await Promise.allSettled([
    pool.query("SELECT 1"),
    getEventServiceClient().readiness(),
    getOrderServiceClient().readiness(),
  ]);
  const checks = {
    postgres: postgres.status === "fulfilled",
    eventService: eventService.status === "fulfilled" && eventService.value.status === "ready",
    orderService: orderService.status === "fulfilled" && orderService.value,
  };
  const ready = checks.postgres && checks.eventService && checks.orderService;

  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    checks,
  });
});

healthRoutes.get("/metrics", async (_req, res) => {
  exportOtlpMetrics();
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.status(200).send(renderHttpMetrics());
});

export default healthRoutes;
