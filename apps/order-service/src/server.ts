import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import {
  CheckoutIdempotencyKeySchema,
  CheckoutResponseSchema,
  HttpErrorSchema,
  InternalCheckoutRequestSchema,
} from "@ticket-live/contracts";
import { requireInternalServiceAuth } from "../../../src/auth/requireInternalServiceAuth.ts";
import { env } from "../../../src/config/env.ts";
import { pool } from "../../../src/db/client.ts";
import { createLogger } from "../../../src/observability/logger.ts";
import { exportOtlpMetrics } from "../../../src/observability/otlpMetricsExporter.ts";
import { renderHttpMetrics } from "../../../src/observability/metrics.ts";
import { httpObservabilityMiddleware } from "../../../src/observability/httpMiddleware.ts";
import { CheckoutError, checkout } from "../../../src/services/orders/checkoutService.ts";
import { startOutboxWorker } from "../../../src/workers/outboxWorker.ts";
import { getPaymentHoldMismatchTotal } from "../../../src/services/orders/reconcileInventory.ts";

const logger = createLogger("ticket-live-order-service");
const app = express();
app.use(httpObservabilityMiddleware);
app.use(express.json({ limit: "100kb" }));
app.use("/internal", requireInternalServiceAuth);

app.post("/internal/orders/checkout", async (req, res) => {
  const body = InternalCheckoutRequestSchema.safeParse(req.body);
  const userId = z.uuid().safeParse(req.header("x-actor-user-id"));
  const idempotencyKey = CheckoutIdempotencyKeySchema.safeParse(req.header("Idempotency-Key"));
  if (!body.success || !userId.success || !idempotencyKey.success) {
    res.status(400).json({ error: "Invalid internal checkout request" });
    return;
  }

  try {
    const result = await checkout(
      userId.data,
      { eventId: body.data.eventId, quantity: body.data.quantity },
      idempotencyKey.data,
      body.data.customer,
    );
    res.status(201).json(CheckoutResponseSchema.parse(result));
  } catch (error) {
    if (error instanceof CheckoutError) {
      res.status(error.status).json(HttpErrorSchema.parse({ error: error.message }));
      return;
    }
    throw error;
  }
});

app.get("/health/live", (_req, res) => res.status(200).json({ status: "ok" }));
app.get("/health/ready", async (_req, res) => {
  const postgres = await pool.query("SELECT 1").then(() => true, () => false);
  res.status(postgres ? 200 : 503).json({
    status: postgres ? "ready" : "not_ready",
    checks: { postgres },
  });
});
app.get("/metrics", async (_req, res) => {
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
});

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  logger.error("Order service request failed", {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  res.status(500).json({ error: "Internal server error" });
};
app.use(errorHandler);

const stopOutboxWorker = startOutboxWorker();
const server = app.listen(env.ORDER_SERVICE_PORT, () => {
  logger.info("Order service listening", { port: env.ORDER_SERVICE_PORT });
});

let isShuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info("Order service shutting down", { signal });
    server.close(() => {
      void stopOutboxWorker().then(() => pool.end()).catch((error) => {
        logger.error("Order service shutdown failed", {
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        process.exitCode = 1;
      });
    });
  });
}
