import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env, corsOrigins } from "./config/env.ts";
import { pool } from "./db/client.ts";
import { requireAuth } from "./auth/requireAuth.ts";
import authRoutes from "./routes/authRoutes.ts";
import eventsRoutes from "./routes/eventsRoutes.ts";
import { elasticsearch } from "./search/client.ts";

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
app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "100kb" }));

app.use("/", authRoutes);

// Keep future application routers below this line so they require a verified access token.
app.use(requireAuth);
app.use("/events", eventsRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  console.error("Request failed", error);

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
  console.log(`Listening on port ${env.PORT}`);
});

let isShuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`Received ${signal}; shutting down`);

    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        console.error("HTTP server shutdown failed", error);
        process.exitCode = 1;
      }

      void pool.end().catch((poolError) => {
        console.error("Database pool shutdown failed", poolError);
        process.exitCode = 1;
      });

      void elasticsearch.close().catch((elasticsearchError) => {
        console.error("Elasticsearch client shutdown failed", elasticsearchError);
        process.exitCode = 1;
      });
    });
  });
}
