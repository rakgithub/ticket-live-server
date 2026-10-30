import express, { type ErrorRequestHandler } from "express";
import { createLogger, env, httpObservabilityMiddleware, requireInternalServiceAuth } from "@ticket-live/runtime";
import { pool } from "./db/client.ts";
import { startTicketingConsumer } from "./messaging/ticketingConsumer.ts";
import ticketRoutes from "./routes/ticketRoutes.ts";
import { createHealthRoutes } from "./routes/healthRoutes.ts";

const logger = createLogger("ticket-live-ticketing-service");
const app = express();
const consumer = startTicketingConsumer();
app.use(httpObservabilityMiddleware);
app.use(express.json({ limit: "100kb" }));
app.use("/internal", requireInternalServiceAuth);
app.use(ticketRoutes);
app.use(createHealthRoutes(() => consumer.isReady()));

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  logger.error("Ticketing service request failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
  res.status(500).json({ error: "Internal server error" });
};
app.use(errorHandler);

const server = app.listen(env.TICKETING_SERVICE_PORT, () => {
  logger.info("Ticketing service listening", { port: env.TICKETING_SERVICE_PORT });
});

let isShuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    server.close(() => {
      void Promise.all([consumer.stop(), pool.end()]).catch((error) => {
        logger.error("Ticketing service shutdown failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
        process.exitCode = 1;
      });
    });
  });
}
