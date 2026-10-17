import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import { HttpErrorSchema, InternalPaymentChargeRequestSchema, InternalPaymentRecordSchema } from "@ticket-live/contracts";
import { createLogger, env, exportOtlpMetrics, httpObservabilityMiddleware, renderHttpMetrics, requireInternalServiceAuth } from "@ticket-live/runtime";
import { pool } from "./db/client.ts";
import { cancelPayment, chargePayment, getPaymentByOrder } from "./services/paymentService.ts";

const logger = createLogger("ticket-live-payment-service");
const app = express();
app.use(httpObservabilityMiddleware);
app.use(express.json({ limit: "100kb" }));
app.use("/internal", requireInternalServiceAuth);

app.post("/internal/payments", async (req, res) => {
  const parsed = InternalPaymentChargeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payment request" });
    return;
  }
  try {
    res.json(InternalPaymentRecordSchema.parse(await chargePayment(parsed.data)));
  } catch (error) {
    if (error instanceof Error && error.message.includes("different amount details")) {
      res.status(409).json(HttpErrorSchema.parse({ error: error.message }));
      return;
    }
    throw error;
  }
});

app.get("/internal/payments/:orderId", async (req, res) => {
  const orderId = z.uuid().safeParse(req.params.orderId);
  if (!orderId.success) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }
  const payment = await getPaymentByOrder(orderId.data);
  if (!payment) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }
  res.json(InternalPaymentRecordSchema.parse(payment));
});

app.post("/internal/payments/:orderId/cancel", async (req, res) => {
  const orderId = z.uuid().safeParse(req.params.orderId);
  if (!orderId.success) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }
  const payment = await cancelPayment(orderId.data);
  if (!payment) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }
  res.json(InternalPaymentRecordSchema.parse(payment));
});

app.get("/health/live", (_req, res) => res.status(200).json({ status: "ok" }));
app.get("/health/ready", async (_req, res) => {
  const postgres = await pool.query("SELECT 1").then(() => true, () => false);
  res.status(postgres ? 200 : 503).json({ status: postgres ? "ready" : "not_ready", checks: { postgres } });
});
app.get("/metrics", (_req, res) => {
  exportOtlpMetrics(undefined, "ticket-live-payment-service");
  res.type("text/plain; version=0.0.4; charset=utf-8").send(renderHttpMetrics());
});

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  logger.error("Payment service request failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
  res.status(500).json({ error: "Internal server error" });
};
app.use(errorHandler);

const server = app.listen(env.PAYMENT_SERVICE_PORT, () => logger.info("Payment service listening", { port: env.PAYMENT_SERVICE_PORT }));
let isShuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    server.close(() => void pool.end().catch((error) => {
      logger.error("Payment service shutdown failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
      process.exitCode = 1;
    }));
  });
}
