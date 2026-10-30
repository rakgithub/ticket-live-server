import express, { type ErrorRequestHandler } from "express";
import { requireInternalServiceAuth, env, createLogger, httpObservabilityMiddleware } from "@ticket-live/runtime";
import { pool } from "./db/client.ts";
import { startEmailWorker } from "./emailWorker.ts";
import { createHealthRoutes } from "./routes/healthRoutes.ts";
import deliveryRoutes from "./routes/deliveryRoutes.ts";

const logger = createLogger("ticket-live-email-service");
const app = express();
const worker = startEmailWorker();
app.use(httpObservabilityMiddleware);
app.use(express.json({ limit: "100kb" }));
app.use("/internal", requireInternalServiceAuth);
app.use(createHealthRoutes(() => worker.isReady()));
app.use(deliveryRoutes);

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
