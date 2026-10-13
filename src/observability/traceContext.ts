import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

export type TraceContext = {
  correlationId: string;
  traceId: string;
  spanId: string;
  traceFlags: string;
  traceparent: string;
  parentSpanId?: string;
  tracestate?: string;
};

const contextStorage = new AsyncLocalStorage<TraceContext>();
const correlationIdSchema = z.uuid();
const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function nonzero(value: string): boolean {
  return /[1-9a-f]/i.test(value);
}

function validTracestate(value: string | undefined): value is string {
  return Boolean(value && value.length <= 512 && /^[\x20-\x7e]+$/.test(value));
}

function nextContext(
  correlationId: string,
  parentTraceparent?: string,
  tracestate?: string,
): TraceContext {
  const match = parentTraceparent?.match(traceparentPattern);
  const traceId = match?.[1]?.toLowerCase() ?? randomHex(16);
  const parentSpanId = match?.[2]?.toLowerCase();
  const traceFlags = match?.[3]?.toLowerCase() ?? "01";
  const spanId = randomHex(8);

  return {
    correlationId,
    traceId,
    spanId,
    traceFlags,
    traceparent: `00-${traceId}-${spanId}-${traceFlags}`,
    ...(parentSpanId ? { parentSpanId } : {}),
    ...(validTracestate(tracestate) ? { tracestate } : {}),
  };
}

export function createHttpTraceContext(headers: {
  correlationId?: string;
  traceparent?: string;
  tracestate?: string;
}): TraceContext {
  const parsedCorrelationId = correlationIdSchema.safeParse(headers.correlationId);
  const correlationId = parsedCorrelationId.success
    ? parsedCorrelationId.data
    : randomUUID();
  const match = headers.traceparent?.match(traceparentPattern);
  const validParent =
    match && nonzero(match[1] ?? "") && nonzero(match[2] ?? "")
      ? headers.traceparent
      : undefined;

  return nextContext(correlationId, validParent, headers.tracestate);
}

export function createMessageTraceContext(headers: {
  correlationId?: string;
  traceparent?: string;
  tracestate?: string;
}): TraceContext {
  return createHttpTraceContext(headers);
}

export function getTraceContext(): TraceContext | undefined {
  return contextStorage.getStore();
}

export function runWithTraceContext<T>(
  context: TraceContext,
  callback: () => T,
): T {
  return contextStorage.run(context, callback);
}

export function withTraceMetadata<T extends Record<string, unknown>>(
  data: T,
): T & { __telemetry: Pick<TraceContext, "correlationId" | "traceparent" | "tracestate"> } {
  const context = getTraceContext();
  if (!context) {
    const fallback = nextContext(randomUUID());
    return {
      ...data,
      __telemetry: {
        correlationId: fallback.correlationId,
        traceparent: fallback.traceparent,
      },
    };
  }

  return {
    ...data,
    __telemetry: {
      correlationId: context.correlationId,
      traceparent: context.traceparent,
      ...(context.tracestate ? { tracestate: context.tracestate } : {}),
    },
  };
}
