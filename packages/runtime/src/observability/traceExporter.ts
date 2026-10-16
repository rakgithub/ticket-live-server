import { env } from "../config/env.ts";
import { createLogger } from "./logger.ts";
import type { TraceContext } from "./traceContext.ts";

const logger = createLogger("ticket-live-observability");
let lastExportWarningAt = 0;

export type SpanStatus = "ok" | "error";

export function startSpan(
  context: TraceContext,
  name: string,
  attributes: Record<string, string | number | boolean> = {},
  serviceName = "ticket-live-public-api",
  kind = 2,
) {
  const startTimeUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();

  return (status: SpanStatus, endAttributes: Record<string, string | number | boolean> = {}) => {
    const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!endpoint || (Number.parseInt(context.traceFlags, 16) & 1) === 0) return;

    const now = (BigInt(Date.now()) * 1_000_000n).toString();
    const spanAttributes = {
      "correlation.id": context.correlationId,
      ...attributes,
      ...endAttributes,
    };

    const payload = {
      resourceSpans: [{
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: serviceName } }],
        },
        scopeSpans: [{
          scope: { name: "ticket-live.observability", version: "1.0.0" },
          spans: [{
            traceId: context.traceId,
            spanId: context.spanId,
            ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
            name,
            kind,
            flags: Number.parseInt(context.traceFlags, 16),
            startTimeUnixNano,
            endTimeUnixNano: now,
            attributes: Object.entries(spanAttributes).map(([key, value]) => ({
              key,
              value: typeof value === "string"
                ? { stringValue: value }
                : typeof value === "boolean"
                  ? { boolValue: value }
                  : { intValue: String(value) },
            })),
            status: { code: status === "error" ? 2 : 1 },
          }],
        }],
      }],
    };

    void sendTrace(endpoint, payload);
  };
}

async function sendTrace(endpoint: string, payload: unknown): Promise<void> {
  try {
    const baseUrl = new URL(endpoint);
    if (!baseUrl.pathname.replace(/\/$/, "").endsWith("/v1/traces")) {
      baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/, "")}/v1/traces`;
    }
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...getOtlpHeaders() },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) warnExportIssue("OTLP trace export failed", { statusCode: response.status });
  } catch {
    warnExportIssue("OTLP trace export unavailable");
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
