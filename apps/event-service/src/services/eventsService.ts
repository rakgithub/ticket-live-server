import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { eventsTable } from "../db/schema/events.ts";
import { outboxEventsTable } from "../db/schema/outboxEvents.ts";
import { withTraceMetadata } from "@ticket-live/runtime";
import type { EventChatCard, EventGenre } from "@ticket-live/contracts";

export type { EventChatCard } from "@ticket-live/contracts";

export type CreateEventInput = {
  name: string;
  description: string;
  location: string;
  genre?: EventGenre | null;
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
  genre: eventsTable.genre,
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
  version: eventsTable.version,
};

export async function getEvents() {
  return db
    .select(eventSelection)
    .from(eventsTable)
    .where(isNull(eventsTable.deletedAt))
    .orderBy(asc(eventsTable.startsAt));
}

/** Load fresh public event details for search hits, preserving search rank. */
export async function getEventChatCards(
  rankedIds: string[],
  { limit, genre, location, now = new Date() }: {
    limit: number;
    genre?: EventGenre;
    location?: string;
    now?: Date;
  },
): Promise<EventChatCard[]> {
  if (rankedIds.length === 0) return [];

  const rows = await db
    .select({
      id: eventsTable.id,
      name: eventsTable.name,
      description: eventsTable.description,
      location: eventsTable.location,
      genre: eventsTable.genre,
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
        ...(genre ? [eq(eventsTable.genre, genre)] : []),
      ),
    );

  const byId = new Map(rows.map((event) => [event.id, event]));
  return rankedIds.flatMap((id) => {
    const event = byId.get(id);
    if (!event) return [];
    if (
      location &&
      !event.location.toLocaleLowerCase().includes(location.toLocaleLowerCase())
    ) return [];

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
        genre: event.genre as EventGenre | null,
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
      payload: withTraceMetadata({
        ...event,
        startsAt: event.startsAt.toISOString(),
        createdAt: event.createdAt.toISOString(),
        updatedAt: event.updatedAt.toISOString(),
        version: event.version,
      }),
    });

    return event;
  });
}

export type UpdateEventInput = Partial<CreateEventInput>;

export class EventUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventUpdateError";
  }
}

export async function updateEvent(userId: string, eventId: string, input: UpdateEventInput) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select({
      minPeople: eventsTable.minPeople,
      maxPeople: eventsTable.maxPeople,
      reservedQuantity: eventsTable.reservedQuantity,
    }).from(eventsTable)
      .where(and(
        eq(eventsTable.id, eventId),
        eq(eventsTable.userId, userId),
        isNull(eventsTable.deletedAt),
      ))
      .for("update");
    if (!current) return undefined;

    const minPeople = input.minPeople ?? current.minPeople;
    const maxPeople = input.maxPeople ?? current.maxPeople;
    if (maxPeople < minPeople) {
      throw new EventUpdateError("maxPeople must be at least minPeople");
    }
    if (maxPeople < current.reservedQuantity) {
      throw new EventUpdateError("maxPeople cannot be lower than the current reserved quantity");
    }

    const [event] = await tx.update(eventsTable).set({
      ...input,
      version: sql`${eventsTable.version} + 1`,
      updatedAt: new Date(),
    }).where(and(eq(eventsTable.id, eventId), eq(eventsTable.userId, userId), isNull(eventsTable.deletedAt)))
      .returning(eventSelection);
    if (!event) return undefined;
    await tx.insert(outboxEventsTable).values({
      eventType: "event.updated", aggregateId: event.id,
      payload: withTraceMetadata({ ...event, startsAt: event.startsAt.toISOString(), createdAt: event.createdAt.toISOString(), updatedAt: event.updatedAt.toISOString() }),
    });
    return event;
  });
}

export async function cancelEvent(userId: string, eventId: string) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select({ isCancelled: eventsTable.isCancelled }).from(eventsTable)
      .where(and(eq(eventsTable.id, eventId), eq(eventsTable.userId, userId), isNull(eventsTable.deletedAt))).for("update");
    if (!current) return undefined;
    if (current.isCancelled) return (await tx.select(eventSelection).from(eventsTable).where(eq(eventsTable.id, eventId)))[0];
    const [event] = await tx.update(eventsTable).set({ isCancelled: true, version: sql`${eventsTable.version} + 1`, updatedAt: new Date() })
      .where(eq(eventsTable.id, eventId)).returning(eventSelection);
    await tx.insert(outboxEventsTable).values({ eventType: "event.cancelled", aggregateId: event.id, payload: withTraceMetadata({ ...event, startsAt: event.startsAt.toISOString(), createdAt: event.createdAt.toISOString(), updatedAt: event.updatedAt.toISOString() }) });
    return event;
  });
}

export async function deleteEvent(userId: string, eventId: string) {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [event] = await tx.update(eventsTable).set({ deletedAt: now, isCancelled: true, version: sql`${eventsTable.version} + 1`, updatedAt: now })
      .where(and(eq(eventsTable.id, eventId), eq(eventsTable.userId, userId), isNull(eventsTable.deletedAt))).returning(eventSelection);
    if (!event) return undefined;
    await tx.insert(outboxEventsTable).values({ eventType: "event.deleted", aggregateId: event.id, payload: withTraceMetadata({ version: event.version }) });
    return event;
  });
}
