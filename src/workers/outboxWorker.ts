import { asc, eq, isNull, sql } from "drizzle-orm";
import { env } from "../config/env.ts";
import { db } from "../db/client.ts";
import { outboxEventsTable } from "../db/schema/outboxEvents.ts";
import {
  publishOrderConfirmation,
  type OrderConfirmationMessage,
} from "../messaging/publishOrderConfirmation.ts";
import { elasticsearch } from "../search/client.ts";
import { ensureEventsIndex, eventsIndexName } from "../search/eventsIndex.ts";

const batchSize = 25;

async function processOutboxEvent(event: {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  if (event.eventType === "event.created") {
    await ensureEventsIndex();
    await elasticsearch.index({
      index: eventsIndexName,
      id: event.aggregateId,
      document: event.payload,
    });
    return;
  }

  if (event.eventType === "order.confirmed") {
    await publishOrderConfirmation({
      eventId: event.id,
      eventType: "order.confirmed",
      occurredAt: event.createdAt.toISOString(),
      data: event.payload as OrderConfirmationMessage["data"],
    });
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
    try {
      await processOutboxEvent(event);

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

      console.error(`Failed to process outbox event ${event.id}`, error);
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
      console.error("Outbox worker batch failed", error);
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
