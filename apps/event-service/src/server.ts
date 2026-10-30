import express, { type ErrorRequestHandler } from "express";
import { requireInternalServiceAuth, env, createLogger, httpObservabilityMiddleware } from "@ticket-live/runtime";
import { pool } from "./db/client.ts";
import { EventSearchUnavailableError, EventUpdateError } from "./controllers/eventsController.ts";
import { InventoryHoldError } from "./controllers/holdsController.ts";
import { expireExpiredInventoryHolds } from "./services/inventoryHoldsService.ts";
import { processEventOutboxBatch } from "./outboxWorker.ts";
import eventsRoutes from "./routes/eventsRoutes.ts";
import healthRoutes from "./routes/healthRoutes.ts";

const logger = createLogger("ticket-live-event-service");
const app = express();
app.use(httpObservabilityMiddleware);
app.use(express.json({ limit: "100kb" }));
app.use("/internal", requireInternalServiceAuth);
app.use(eventsRoutes);
app.use(healthRoutes);

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof EventUpdateError) { res.status(409).json({ error: error.message }); return; }
  if (error instanceof InventoryHoldError) { res.status(error.status).json({ error: error.message }); return; }
  if (error instanceof EventSearchUnavailableError) { res.status(503).json({ error: error.message }); return; }
  logger.error("Event service request failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
  res.status(500).json({ error: "Internal server error" });
};
app.use(errorHandler);
const server = app.listen(env.EVENT_SERVICE_PORT, () => logger.info("Event service listening", { port: env.EVENT_SERVICE_PORT }));
const timer = setInterval(() => void expireExpiredInventoryHolds().catch((error) => logger.error("Hold expiry failed", { errorType: error instanceof Error ? error.name : "UnknownError" })), env.INVENTORY_HOLD_EXPIRY_POLL_INTERVAL_MS);
timer.unref();
const outboxTimer = setInterval(() => void processEventOutboxBatch().catch((error) => logger.error("Event outbox failed", { errorType: error instanceof Error ? error.name : "UnknownError" })), env.OUTBOX_POLL_INTERVAL_MS);
outboxTimer.unref();
void processEventOutboxBatch().catch((error) => logger.error("Event outbox failed", { errorType: error instanceof Error ? error.name : "UnknownError" }));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { clearInterval(timer); clearInterval(outboxTimer); server.close(); void pool.end(); });
