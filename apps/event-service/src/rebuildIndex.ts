import { db, pool } from "../../../src/db/client.ts";
import { eventsTable } from "../../../src/db/schema/events.ts";
import { elasticsearch } from "../../../src/search/client.ts";
import { ensureEventsIndex, eventsIndexName, resetEventsIndexReadiness } from "../../../src/search/eventsIndex.ts";
import { createLogger } from "../../../src/observability/logger.ts";

const logger = createLogger("ticket-live-event-index-rebuild");

async function main(): Promise<void> {
  const events = await db.select().from(eventsTable);
  if (await elasticsearch.indices.exists({ index: eventsIndexName })) {
    await elasticsearch.indices.delete({ index: eventsIndexName });
  }
  resetEventsIndexReadiness();
  await ensureEventsIndex();
  for (const event of events) {
    await elasticsearch.index({
      index: eventsIndexName,
      id: event.id,
      version: event.version,
      version_type: "external_gte",
      document: {
        id: event.id,
        name: event.name,
        description: event.description,
        location: event.location,
        minPeople: event.minPeople,
        maxPeople: event.maxPeople,
        reservedQuantity: event.reservedQuantity,
        ticketPriceCents: event.ticketPriceCents,
        currencyCode: event.currencyCode.trim(),
        servesAlcohol: event.servesAlcohol,
        isCancelled: event.isCancelled,
        isDeleted: event.deletedAt !== null,
        userId: event.userId,
        startsAt: event.startsAt.toISOString(),
        createdAt: event.createdAt.toISOString(),
        updatedAt: event.updatedAt.toISOString(),
        version: event.version,
      },
    });
  }
  await elasticsearch.indices.refresh({ index: eventsIndexName });
  logger.info("Event search index rebuilt", { eventCount: events.length });
}

try {
  await main();
} finally {
  await Promise.allSettled([pool.end(), elasticsearch.close()]);
}
