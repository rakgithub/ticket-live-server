import { env } from "../config/env.ts";
import { createLogger } from "./logger.ts";
import { getOtlpMetricSnapshot } from "./metrics.ts";

const logger = createLogger("ticket-live-observability");
let lastExportWarningAt = 0;

export function exportOtlpMetrics(outbox?: { pending: number; oldestAgeSeconds: number }): void {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;

  const snapshot = getOtlpMetricSnapshot(outbox);
  const histogramBounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
  const timestamp = snapshot.timeUnixNano;
  const httpMetric = {
    name: "http.server.request.duration",
    description: "HTTP server request duration",
    unit: "s",
    histogram: {
      aggregationTemporality: 2,
      dataPoints: snapshot.httpSeries.map((series) => {
        let previous = 0;
        const bucketCounts = series.bucketCounts.map((cumulative) => {
          const value = cumulative - previous;
          previous = cumulative;
          return String(value);
        });
        bucketCounts.push(String(series.count - previous));
        return {
          attributes: [
            { key: "http.request.method", value: { stringValue: series.method } },
            { key: "http.route", value: { stringValue: series.route } },
            { key: "http.response.status_class", value: { stringValue: series.status } },
          ],
          startTimeUnixNano: snapshot.processStartTimeUnixNano,
          timeUnixNano: timestamp,
          count: String(series.count),
          sum: series.sum,
          explicitBounds: histogramBounds,
          bucketCounts,
        };
      }),
    },
  };
  const requestCountMetric = {
    name: "http.server.request.count",
    description: "Completed HTTP server requests",
    unit: "{request}",
    sum: {
      aggregationTemporality: 2,
      isMonotonic: true,
      dataPoints: snapshot.httpSeries.map((series) => ({
        attributes: [
          { key: "http.request.method", value: { stringValue: series.method } },
          { key: "http.route", value: { stringValue: series.route } },
          { key: "http.response.status_class", value: { stringValue: series.status } },
        ],
        startTimeUnixNano: snapshot.processStartTimeUnixNano,
        timeUnixNano: timestamp,
        asInt: String(series.count),
      })),
    },
  };
  const metrics: unknown[] = [httpMetric, requestCountMetric];
  if (snapshot.outbox) {
    metrics.push(
      {
        name: "ticketlive.outbox.pending",
        description: "Number of unpublished outbox rows",
        unit: "{row}",
        gauge: {
          dataPoints: [{ timeUnixNano: timestamp, asInt: String(snapshot.outbox.pending) }],
        },
      },
      {
        name: "ticketlive.outbox.oldest_age",
        description: "Age of the oldest unpublished outbox row",
        unit: "s",
        gauge: {
          dataPoints: [{ timeUnixNano: timestamp, asDouble: snapshot.outbox.oldestAgeSeconds }],
        },
      },
    );
  }

  void sendMetrics(endpoint, {
    resourceMetrics: [{
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "ticket-live-public-api" } }],
      },
      scopeMetrics: [{
        scope: { name: "ticket-live.observability", version: "1.0.0" },
        metrics,
      }],
    }],
  });
}

async function sendMetrics(endpoint: string, payload: unknown): Promise<void> {
  try {
    const metricsUrl = new URL(endpoint);
    if (!metricsUrl.pathname.replace(/\/$/, "").endsWith("/v1/metrics")) {
      metricsUrl.pathname = `${metricsUrl.pathname.replace(/\/$/, "")}/v1/metrics`;
    }
    const response = await fetch(metricsUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...getOtlpHeaders() },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) warnExportIssue("OTLP metric export failed", { statusCode: response.status });
  } catch {
    warnExportIssue("OTLP metric export unavailable");
  }
}

function warnExportIssue(message: string, fields?: { statusCode?: number }): void {
  const now = Date.now();
  if (now - lastExportWarningAt < 60_000) return;
  lastExportWarningAt = now;
  logger.warn(message, fields);
}

function getOtlpHeaders(): Record<string, string> {
  const value = env.OTEL_EXPORTER_OTLP_HEADERS;
  if (!value) return {};

  const headers: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    const rawValue = pair.slice(separator + 1).trim();
    if (!key) continue;
    try {
      headers[key] = decodeURIComponent(rawValue);
    } catch {
      headers[key] = rawValue;
    }
  }
  return headers;
}
