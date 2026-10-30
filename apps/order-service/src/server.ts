import express, { type ErrorRequestHandler } from "express";
import { requireInternalServiceAuth } from "@ticket-live/runtime";
import { env } from "@ticket-live/runtime";
import { pool } from "./db/client.ts";
import { createLogger } from "@ticket-live/runtime";
import { httpObservabilityMiddleware } from "@ticket-live/runtime";
import { startOutboxWorker } from "./workers/outboxWorker.ts";
import ordersRoutes from "./routes/ordersRoutes.ts";
import healthRoutes from "./routes/healthRoutes.ts";

const logger = createLogger("ticket-live-order-service");
const app = express();
app.use(httpObservabilityMiddleware);
app.use(express.json({ limit: "100kb" }));
app.use("/internal", requireInternalServiceAuth);
app.use(ordersRoutes);
app.use(healthRoutes);

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
