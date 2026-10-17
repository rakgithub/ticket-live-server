import express from "express";
import {
  createLogger,
  env,
  exportOtlpMetrics,
  httpObservabilityMiddleware,
  renderHttpMetrics,
} from "@ticket-live/runtime";

const logger = createLogger("ticket-live-analytics-service");
const app = express();

app.use(httpObservabilityMiddleware);
app.use(express.json({ limit: "100kb" }));

app.get("/health/live", (_req, res) => res.status(200).json({ status: "ok" }));
app.get("/health/ready", (_req, res) => res.status(200).json({ status: "ready" }));
app.get("/metrics", (_req, res) => {
  exportOtlpMetrics(undefined, "ticket-live-analytics-service");
  res.type("text/plain; version=0.0.4; charset=utf-8").send(renderHttpMetrics());
});

const server = app.listen(env.ANALYTICS_SERVICE_PORT, () => {
  logger.info("Analytics service listening", { port: env.ANALYTICS_SERVICE_PORT });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close());
}
