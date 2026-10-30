import express from "express";
import {
  createLogger,
  env,
  httpObservabilityMiddleware,
} from "@ticket-live/runtime";
import healthRoutes from "./routes/healthRoutes.ts";

const logger = createLogger("ticket-live-analytics-service");
const app = express();

app.use(httpObservabilityMiddleware);
app.use(express.json({ limit: "100kb" }));

app.use(healthRoutes);

const server = app.listen(env.ANALYTICS_SERVICE_PORT, () => {
  logger.info("Analytics service listening", { port: env.ANALYTICS_SERVICE_PORT });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close());
}
