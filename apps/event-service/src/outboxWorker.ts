import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { db } from "./db/client.ts";
import { outboxEventsTable } from "./db/schema/outboxEvents.ts";
import { ensureEventsIndex, eventsIndexName } from "./search/eventsIndex.ts";
import { elasticsearch } from "./search/client.ts";
import { createLogger } from "@ticket-live/runtime";
import { buildEventTicketInvalidation, eventTicketInvalidationTraceHeaders, publishEventTicketInvalidation } from "./messaging/publishTicketingEvent.ts";

const logger = createLogger("ticket-live-event-outbox-worker");
let isProcessing = false;

export async function processEventOutboxBatch(): Promise<number> {
  if (isProcessing) return 0;
  isProcessing = true;
  try {
  const rows = await db.select().from(outboxEventsTable)
    .where(and(isNull(outboxEventsTable.processedAt), lte(outboxEventsTable.availableAt, new Date())))
    .orderBy(asc(outboxEventsTable.createdAt)).limit(25);
  for (const row of rows) {
    try {
      const payload = { ...row.payload }; delete payload.__telemetry;
      await ensureEventsIndex();
      if (!["event.created", "event.updated", "event.cancelled", "event.deleted"].includes(row.eventType)) {
        throw new Error(`Unsupported Event outbox type: ${row.eventType}`);
      }
      const version = typeof payload.version === "number" && Number.isInteger(payload.version) && payload.version > 0 ? payload.version : 1;
      await elasticsearch.index({
        index: eventsIndexName,
        id: row.aggregateId,
        document: { ...payload, id: row.aggregateId, version, isDeleted: row.eventType === "event.deleted" },
        version,
        version_type: "external_gte",
      });
      if (row.eventType === "event.cancelled" || row.eventType === "event.deleted") {
        await publishEventTicketInvalidation(buildEventTicketInvalidation(row), eventTicketInvalidationTraceHeaders(row.payload));
      }
      await db.update(outboxEventsTable).set({ processedAt: new Date(), lastError: null }).where(eq(outboxEventsTable.id, row.id));
    } catch (error) {
      const attempts = row.attempts + 1;
      const delay = Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
      await db.update(outboxEventsTable).set({ attempts, availableAt: new Date(Date.now() + delay + Math.floor(Math.random() * delay / 4)), lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) }).where(eq(outboxEventsTable.id, row.id));
      logger.error("Event outbox row failed", { eventId: row.id, eventType: row.eventType, aggregateId: row.aggregateId, attempts });
    }
  }
  return rows.length;
  } finally {
    isProcessing = false;
  }
}
