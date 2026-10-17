import express from "express";
import {
  createLogger,
  env,
  exportOtlpMetrics,
  httpObservabilityMiddleware,
  renderHttpMetrics,
} from "@ticket-live/runtime";

const logger = createLogger("ticket-live-ticketing-service");
const app = express();

app.use(httpObservabilityMiddleware);
app.use(express.json({ limit: "100kb" }));

app.get("/health/live", (_req, res) => res.status(200).json({ status: "ok" }));
app.get("/health/ready", (_req, res) => res.status(200).json({ status: "ready" }));
app.get("/metrics", (_req, res) => {
  exportOtlpMetrics(undefined, "ticket-live-ticketing-service");
  res.type("text/plain; version=0.0.4; charset=utf-8").send(renderHttpMetrics());
});

const server = app.listen(env.TICKETING_SERVICE_PORT, () => {
  logger.info("Ticketing service listening", { port: env.TICKETING_SERVICE_PORT });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close());
}
