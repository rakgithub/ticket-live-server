import { and, asc, eq, gte, inArray, isNull } from "drizzle-orm";
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

export type EventChatCard = {
  id: string;
  name: string;
  descriptionPreview: string;
  location: string;
  startsAt: string;
  ticketPriceCents: number;
  currencyCode: string;
  minPeople: number;
  maxPeople: number;
  servesAlcohol: boolean;
};

/** Load fresh public event details for search hits, preserving search rank. */
export async function getEventChatCards(
  rankedIds: string[],
  { limit, now = new Date() }: { limit: number; now?: Date },
): Promise<EventChatCard[]> {
  if (rankedIds.length === 0) return [];

  const rows = await db
    .select({
      id: eventsTable.id,
      name: eventsTable.name,
      description: eventsTable.description,
      location: eventsTable.location,
      startsAt: eventsTable.startsAt,
      ticketPriceCents: eventsTable.ticketPriceCents,
      currencyCode: eventsTable.currencyCode,
      minPeople: eventsTable.minPeople,
      maxPeople: eventsTable.maxPeople,
      servesAlcohol: eventsTable.servesAlcohol,
    })
    .from(eventsTable)
    .where(
      and(
        inArray(eventsTable.id, rankedIds),
        isNull(eventsTable.deletedAt),
        eq(eventsTable.isCancelled, false),
        gte(eventsTable.startsAt, now),
      ),
    );

  const byId = new Map(rows.map((event) => [event.id, event]));
  return rankedIds.flatMap((id) => {
    const event = byId.get(id);
    if (!event) return [];

    const descriptionPreview =
      event.description.length > 240
        ? `${event.description.slice(0, 237).trimEnd()}…`
        : event.description;

    return [
      {
        id: event.id,
        name: event.name,
        descriptionPreview,
        location: event.location,
        startsAt: event.startsAt.toISOString(),
        ticketPriceCents: event.ticketPriceCents,
        currencyCode: event.currencyCode.trim(),
        minPeople: event.minPeople,
        maxPeople: event.maxPeople,
        servesAlcohol: event.servesAlcohol,
      },
    ];
  }).slice(0, limit);
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
