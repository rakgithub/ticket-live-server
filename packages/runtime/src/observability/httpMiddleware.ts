import type { RequestHandler } from "express";
import { createLogger } from "./logger.ts";
import { observeHttpRequest } from "./metrics.ts";
import { createHttpTraceContext, runWithTraceContext } from "./traceContext.ts";
import { startSpan } from "./traceExporter.ts";
import { env } from "../config/env.ts";

const logger = createLogger("ticket-live-http");
const serviceName = env.TICKETLIVE_SERVICE === "public-api"
  ? "ticket-live-public-api"
  : `ticket-live-${env.TICKETLIVE_SERVICE}-service`;

export const httpObservabilityMiddleware: RequestHandler = (req, res, next) => {
  const context = createHttpTraceContext({
    correlationId: req.header("x-correlation-id"),
    traceparent: req.header("traceparent"),
    tracestate: req.header("tracestate"),
  });
  const finishSpan = startSpan(context, "http.server.request", {
    "http.request.method": req.method,
  }, serviceName);
  const startTime = process.hrtime.bigint();

  res.setHeader("x-correlation-id", context.correlationId);
  runWithTraceContext(context, () => {
    res.once("finish", () => {
      runWithTraceContext(context, () => {
        const routePath = req.route?.path;
        const route = typeof routePath === "string" ? `${req.baseUrl}${routePath}` : "unmatched";
        const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1_000_000_000;
        const statusCode = res.statusCode;
        observeHttpRequest({
          method: req.method,
          route,
          statusCode,
          seconds: durationSeconds,
        });
        finishSpan(statusCode >= 500 ? "error" : "ok", {
          "http.route": route,
          "http.response.status_code": statusCode,
        });

        if (req.path !== "/metrics" && req.path !== "/health/live" && req.path !== "/health/ready") {
          logger.info("HTTP request completed", {
            method: req.method,
            route,
            statusCode,
            durationMs: Math.round(durationSeconds * 1_000),
          });
        }
      });
    });
    next();
  });
};
