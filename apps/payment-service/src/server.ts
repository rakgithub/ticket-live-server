import express, { type ErrorRequestHandler } from "express";
import { createLogger, env, httpObservabilityMiddleware, requireInternalServiceAuth } from "@ticket-live/runtime";
import { pool } from "./db/client.ts";
import paymentRoutes from "./routes/paymentRoutes.ts";
import healthRoutes from "./routes/healthRoutes.ts";

const logger = createLogger("ticket-live-payment-service");
const app = express();
app.use(httpObservabilityMiddleware);
app.use(express.json({ limit: "100kb" }));
app.use("/internal", requireInternalServiceAuth);
app.use(paymentRoutes);
app.use(healthRoutes);

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
