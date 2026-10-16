import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { env } from "../config/env.ts";
import { db } from "../db/client.ts";
import { orderOutboxEventsTable } from "../db/schema/orderOutboxEvents.ts";
import { publishEmailSendCommand } from "../messaging/publishOrderConfirmation.ts";
import { createLogger } from "../observability/logger.ts";
import {
  createMessageTraceContext,
  runWithTraceContext,
} from "../observability/traceContext.ts";
import { startSpan } from "../observability/traceExporter.ts";
import { expirePendingReservations } from "../services/orders/expireReservationsService.ts";
import { reconcileCheckoutState } from "../services/orders/checkoutService.ts";
import { releaseInventoryHoldCommand } from "../services/orders/releaseInventoryHold.ts";
import { reconcileOrderInventory } from "../services/orders/reconcileInventory.ts";
import { buildOrderConfirmationEmailCommand } from "../messaging/orderConfirmation.ts";

const batchSize = 25;
const logger = createLogger("ticket-live-outbox-worker");
let lastInventoryReconciliationAt = 0;

type PendingOutboxEvent = {
  source: "order";
  id: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  attempts: number;
};

async function processOutboxEvent(event: {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}): Promise<void> {
  const payload = { ...event.payload };
  if (event.eventType === "order.confirmed") {
    await publishEmailSendCommand(buildOrderConfirmationEmailCommand(event));
    return;
  }

  if (event.eventType === "inventory.hold.release") {
    const holdId = payload.holdId;
    if (typeof holdId !== "string") {
      throw new Error("Inventory hold release command has no hold ID");
    }
    await releaseInventoryHoldCommand(holdId);
    return;
  }

  throw new Error(`Unsupported outbox event type: ${event.eventType}`);
}

export async function processOutboxBatch(): Promise<number> {
  try {
    await expirePendingReservations();
    await reconcileCheckoutState();
    if (Date.now() - lastInventoryReconciliationAt >= env.INVENTORY_RECONCILIATION_INTERVAL_MS) {
      lastInventoryReconciliationAt = Date.now();
      await reconcileOrderInventory();
    }
  } catch (error) {
    logger.error("Order maintenance pass failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }

  const now = new Date();
  const orderOutboxRows = await db
      .select({
        id: orderOutboxEventsTable.id,
        eventType: orderOutboxEventsTable.eventType,
        aggregateId: orderOutboxEventsTable.aggregateId,
        payload: orderOutboxEventsTable.payload,
        createdAt: orderOutboxEventsTable.createdAt,
        attempts: orderOutboxEventsTable.attempts,
      })
      .from(orderOutboxEventsTable)
      .where(and(
        isNull(orderOutboxEventsTable.processedAt),
        lte(orderOutboxEventsTable.availableAt, now),
      ))
      .orderBy(asc(orderOutboxEventsTable.createdAt))
      .limit(batchSize);
  const pendingEvents: PendingOutboxEvent[] = [
    ...orderOutboxRows.map((event) => ({ ...event, source: "order" as const })),
  ]
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
    .slice(0, batchSize);

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

      await db.update(orderOutboxEventsTable).set({ processedAt: new Date(), lastError: null }).where(eq(orderOutboxEventsTable.id, event.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      const retryDelayMs = Math.min(
        300_000,
        1_000 * 2 ** Math.min(event.attempts, 8),
      );
      const jitterMs = Math.floor(Math.random() * Math.max(1, retryDelayMs / 4));
      const availableAt = new Date(Date.now() + retryDelayMs + jitterMs);

      await db
          .update(orderOutboxEventsTable)
          .set({
            attempts: sql`${orderOutboxEventsTable.attempts} + 1`,
            availableAt,
            lastError: message.slice(0, 2_000),
          })
          .where(eq(orderOutboxEventsTable.id, event.id));

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
