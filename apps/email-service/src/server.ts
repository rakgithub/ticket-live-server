import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import { EmailDeliveryResponseSchema } from "@ticket-live/contracts";
import { requireInternalServiceAuth } from "../../../src/auth/requireInternalServiceAuth.ts";
import { env } from "../../../src/config/env.ts";
import { pool } from "../../../src/db/client.ts";
import { createLogger } from "../../../src/observability/logger.ts";
import { getDeliveryByNotificationKey, getEmailDeliveryMetricRows } from "./deliveryStore.ts";
import { renderEmailMetrics } from "./metrics.ts";
import { startEmailWorker } from "./emailWorker.ts";

const logger = createLogger("ticket-live-email-service");
const app = express();
const worker = startEmailWorker();

app.use(express.json({ limit: "100kb" }));
app.use("/internal", requireInternalServiceAuth);

app.get("/metrics", async (_req, res) => {
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
});

app.get("/internal/deliveries/:notificationKey", async (req, res) => {
  const key = z.string().trim().min(1).max(255).safeParse(req.params.notificationKey);
  if (!key.success) {
    res.status(400).json({ error: "Invalid notification key" });
    return;
  }

  const delivery = await getDeliveryByNotificationKey(key.data);
  if (!delivery) {
    res.status(404).json({ error: "Delivery not found" });
    return;
  }

  res.json(EmailDeliveryResponseSchema.parse({
    delivery: {
      ...delivery,
      providerAcceptedAt: delivery.providerAcceptedAt?.toISOString() ?? null,
      deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
      bouncedAt: delivery.bouncedAt?.toISOString() ?? null,
      failedAt: delivery.failedAt?.toISOString() ?? null,
      createdAt: delivery.createdAt.toISOString(),
      updatedAt: delivery.updatedAt.toISOString(),
    },
  }));
});

app.get("/health/live", (_req, res) => res.status(200).json({ status: "ok" }));
app.get("/health/ready", async (_req, res) => {
  const postgres = await pool.query("SELECT 1").then(() => true, () => false);
  const checks = { postgres, rabbitmq: worker.isReady() };
  const ready = checks.postgres && checks.rabbitmq;
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
});

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  logger.error("Email service request failed", {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  res.status(500).json({ error: "Internal server error" });
};
app.use(errorHandler);

const server = app.listen(env.EMAIL_SERVICE_PORT, () => {
  logger.info("Email service listening", { port: env.EMAIL_SERVICE_PORT });
});

let isShuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info("Email service shutting down", { signal });
    server.close(() => {
      void worker.stop().then(() => pool.end()).catch((error) => {
        logger.error("Email service shutdown failed", {
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        process.exitCode = 1;
      });
    });
  });
}
