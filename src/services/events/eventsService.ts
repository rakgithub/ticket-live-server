import { asc, isNull } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { eventsTable } from "../../db/schema/events.ts";

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
  const [event] = await db
    .insert(eventsTable)
    .values({
      ...input,
      userId,
    })
    .returning(eventSelection);

  return event;
}
