import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import { env, corsOrigins } from "./config/env.ts";
import { pool } from "./db/client.ts";
import { requireAuth } from "./auth/requireAuth.ts";
import { requireInternalServiceAuth } from "./auth/requireInternalServiceAuth.ts";
import authRoutes from "./routes/authRoutes.ts";
import eventsRoutes from "./routes/eventsRoutes.ts";
import internalInventoryRoutes from "./routes/internalInventoryRoutes.ts";
import { elasticsearch } from "./search/client.ts";
import ordersRoutes from "./routes/ordersRoutes.ts";
import chatRoutes from "./routes/chatRoutes.ts";
import healthRoutes from "./routes/healthRoutes.ts";
import { httpObservabilityMiddleware } from "./observability/httpMiddleware.ts";
import { createLogger } from "./observability/logger.ts";
import { expireExpiredInventoryHolds } from "./services/events/inventoryHoldsService.ts";

const logger = createLogger("ticket-live-public-api");

const app = express();

if (env.TRUST_PROXY_HOPS > 0) {
  app.set("trust proxy", env.TRUST_PROXY_HOPS);
}

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      callback(null, !origin || corsOrigins.has(origin));
    },
    credentials: true,
  }),
);
app.use(httpObservabilityMiddleware);
app.use(express.json({ limit: "100kb" }));
app.use(healthRoutes);

app.use("/", authRoutes);

// Service-only endpoints live outside the browser-facing bearer-token routes.
app.use("/internal", requireInternalServiceAuth, internalInventoryRoutes);

// Keep future application routers below this line so they require a verified access token.
app.use(requireAuth);
app.use("/events", eventsRoutes);
app.use("/orders", ordersRoutes);
app.use("/chat", chatRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  logger.error("Request failed", {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });

  if (res.headersSent) {
    next(error);
    return;
  }

  const status =
    typeof error === "object" && error !== null && "status" in error &&
    typeof error.status === "number" && error.status >= 400 && error.status < 500
      ? error.status
      : 500;

  res.status(status).json({
    error: status === 500 ? "Internal server error" : "Invalid request",
  });
};

app.use(errorHandler);

const server = app.listen(env.PORT, () => {
  logger.info("HTTP server listening", { port: env.PORT });
});

async function runInventoryHoldExpiry(): Promise<void> {
  try {
    await expireExpiredInventoryHolds();
  } catch (error) {
    logger.error("Inventory hold expiry pass failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

void runInventoryHoldExpiry();
const inventoryHoldExpiryTimer = setInterval(
  () => void runInventoryHoldExpiry(),
  env.INVENTORY_HOLD_EXPIRY_POLL_INTERVAL_MS,
);
inventoryHoldExpiryTimer.unref();

let isShuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    clearInterval(inventoryHoldExpiryTimer);
    logger.info("HTTP server shutting down", { signal });

    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        logger.error("HTTP server shutdown failed", {
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        process.exitCode = 1;
      }

      void pool.end().catch((poolError) => {
        logger.error("Database pool shutdown failed", {
          errorType: poolError instanceof Error ? poolError.name : "UnknownError",
        });
        process.exitCode = 1;
      });

      void elasticsearch.close().catch((elasticsearchError) => {
        logger.error("Elasticsearch client shutdown failed", {
          errorType: elasticsearchError instanceof Error ? elasticsearchError.name : "UnknownError",
        });
        process.exitCode = 1;
      });
    });
  });
}
