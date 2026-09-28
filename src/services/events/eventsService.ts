import { asc, isNull } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { eventsTable } from "../../db/schema/events.ts";
import { outboxEventsTable } from "../../db/schema/outboxEvents.ts";

export type CreateEventInput = {
  name: string;
  description: string;
  location: string;
  minPeople: number;
  maxPeople: number;
  ticketPriceCents: number;
  currencyCode: string;
  servesAlcohol: boolean;
  startsAt: Date;
};

const eventSelection = {
  id: eventsTable.id,
  name: eventsTable.name,
  description: eventsTable.description,
  location: eventsTable.location,
  minPeople: eventsTable.minPeople,
  maxPeople: eventsTable.maxPeople,
  reservedQuantity: eventsTable.reservedQuantity,
  ticketPriceCents: eventsTable.ticketPriceCents,
  currencyCode: eventsTable.currencyCode,
  servesAlcohol: eventsTable.servesAlcohol,
  isCancelled: eventsTable.isCancelled,
  userId: eventsTable.userId,
  startsAt: eventsTable.startsAt,
  createdAt: eventsTable.createdAt,
  updatedAt: eventsTable.updatedAt,
};

export async function getEvents() {
  return db
    .select(eventSelection)
    .from(eventsTable)
    .where(isNull(eventsTable.deletedAt))
    .orderBy(asc(eventsTable.startsAt));
}

export async function createEvent(
  userId: string,
  input: CreateEventInput,
) {
  return db.transaction(async (tx) => {
    const [event] = await tx
      .insert(eventsTable)
      .values({
        ...input,
        userId,
      })
      .returning(eventSelection);

    await tx.insert(outboxEventsTable).values({
      eventType: "event.created",
      aggregateId: event.id,
      payload: {
        ...event,
        startsAt: event.startsAt.toISOString(),
        createdAt: event.createdAt.toISOString(),
        updatedAt: event.updatedAt.toISOString(),
      },
    });

    return event;
  });
}
