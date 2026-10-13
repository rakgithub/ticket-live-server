import { asc, eq, isNull, sql } from "drizzle-orm";
import { env } from "../config/env.ts";
import { db } from "../db/client.ts";
import { outboxEventsTable } from "../db/schema/outboxEvents.ts";
import {
  publishOrderConfirmation,
  type OrderConfirmationMessage,
} from "../messaging/publishOrderConfirmation.ts";
import { OrderConfirmedV1Schema } from "@ticket-live/contracts";
import { createLogger } from "../observability/logger.ts";
import {
  createMessageTraceContext,
  runWithTraceContext,
} from "../observability/traceContext.ts";
import { startSpan } from "../observability/traceExporter.ts";
import { elasticsearch } from "../search/client.ts";
import { ensureEventsIndex, eventsIndexName } from "../search/eventsIndex.ts";

const batchSize = 25;
const logger = createLogger("ticket-live-outbox-worker");

async function processOutboxEvent(event: {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const { __telemetry, ...payload } = event.payload;
  if (event.eventType === "event.created") {
    await ensureEventsIndex();
    await elasticsearch.index({
      index: eventsIndexName,
      id: event.aggregateId,
      document: payload,
    });
    return;
  }

  if (event.eventType === "order.confirmed") {
    await publishOrderConfirmation(OrderConfirmedV1Schema.parse({
      eventId: event.id,
      eventType: "order.confirmed",
      schemaVersion: 1,
      aggregateId: event.aggregateId,
      occurredAt: event.createdAt.toISOString(),
      correlationId:
        typeof __telemetry === "object" && __telemetry !== null && "correlationId" in __telemetry &&
        typeof __telemetry.correlationId === "string"
          ? __telemetry.correlationId
          : event.id,
      data: payload as OrderConfirmationMessage["data"],
    }));
    return;
  }

  throw new Error(`Unsupported outbox event type: ${event.eventType}`);
}

export async function processOutboxBatch(): Promise<number> {
  const pendingEvents = await db
    .select({
      id: outboxEventsTable.id,
      eventType: outboxEventsTable.eventType,
      aggregateId: outboxEventsTable.aggregateId,
      payload: outboxEventsTable.payload,
      createdAt: outboxEventsTable.createdAt,
    })
    .from(outboxEventsTable)
    .where(isNull(outboxEventsTable.processedAt))
    .orderBy(asc(outboxEventsTable.createdAt))
    .limit(batchSize);

  for (const event of pendingEvents) {
    const telemetry = event.payload.__telemetry;
    const telemetryFields =
      typeof telemetry === "object" && telemetry !== null
        ? telemetry as Record<string, unknown>
        : {};
    const context = createMessageTraceContext({
      correlationId:
        typeof telemetryFields.correlationId === "string"
          ? telemetryFields.correlationId
          : event.id,
      traceparent:
        typeof telemetryFields.traceparent === "string"
          ? telemetryFields.traceparent
          : undefined,
      tracestate:
        typeof telemetryFields.tracestate === "string"
          ? telemetryFields.tracestate
          : undefined,
    });

    try {
      await runWithTraceContext(context, async () => {
        const finishSpan = startSpan(context, "outbox.process", {
          "messaging.message.id": event.id,
          "messaging.event.type": event.eventType,
          "aggregate.id": event.aggregateId,
        }, "ticket-live-outbox-worker", 1);
        try {
          await processOutboxEvent(event);
          finishSpan("ok");
        } catch (error) {
          finishSpan("error");
          throw error;
        }
      });

      await db
        .update(outboxEventsTable)
        .set({ processedAt: new Date(), lastError: null })
        .where(eq(outboxEventsTable.id, event.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await db
        .update(outboxEventsTable)
        .set({
          attempts: sql`${outboxEventsTable.attempts} + 1`,
          lastError: message.slice(0, 2_000),
        })
        .where(eq(outboxEventsTable.id, event.id));

      logger.error("Outbox event processing failed", {
        messageId: event.id,
        eventId: event.id,
        orderId: event.eventType === "order.confirmed" ? event.aggregateId : undefined,
        correlationId: context.correlationId,
        eventType: event.eventType,
        aggregateId: event.aggregateId,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  return pendingEvents.length;
}

export function startOutboxWorker(): () => Promise<void> {
  let isProcessing = false;
  let currentRun: Promise<void> | undefined;

  const run = async () => {
    if (isProcessing) return;
    isProcessing = true;

    try {
      await processOutboxBatch();
    } catch (error) {
      logger.error("Outbox worker batch failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    } finally {
      isProcessing = false;
    }
  };

  const runAndTrack = () => {
    if (isProcessing) return currentRun ?? Promise.resolve();
    currentRun = run();
    return currentRun;
  };

  void runAndTrack();
  const timer = setInterval(() => void runAndTrack(), env.OUTBOX_POLL_INTERVAL_MS);

  return async () => {
    clearInterval(timer);
    await currentRun;
  };
}
