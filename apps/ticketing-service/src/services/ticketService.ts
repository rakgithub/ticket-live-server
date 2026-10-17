import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { EventTicketInvalidationV1, TicketingOrderConfirmedV1, TicketCheckInRequest } from "@ticket-live/contracts";
import { db } from "../db/client.ts";
import { cancelledEventsTable, ticketsTable, type TicketRecord } from "../db/schema/index.ts";

export class TicketCheckInError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
    this.name = "TicketCheckInError";
  }
}

export async function issueOrderTickets(event: TicketingOrderConfirmedV1): Promise<void> {
  const order = event.data;
  if (event.aggregateId !== order.orderId) {
    throw new Error("Order confirmation aggregate does not match its order ID");
  }

  const issuedAt = new Date(event.occurredAt);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${order.event.id}, 0))`);
    const existing = await tx.select({
      eventId: ticketsTable.eventId,
      holderName: ticketsTable.holderName,
      eventName: ticketsTable.eventName,
      eventLocation: ticketsTable.eventLocation,
      eventStartsAt: ticketsTable.eventStartsAt,
      ticketNumber: ticketsTable.ticketNumber,
    }).from(ticketsTable).where(eq(ticketsTable.orderId, order.orderId));

    if (existing.length > 0) {
      const matchesOrder = existing.every((ticket) =>
        ticket.eventId === order.event.id &&
        ticket.holderName === order.customer.name &&
        ticket.eventName === order.event.name &&
        ticket.eventLocation === order.event.location &&
        ticket.eventStartsAt.toISOString() === order.event.startsAt
      );
      const allNumbersPresent = existing.length === order.quantity &&
        Array.from({ length: order.quantity }, (_, index) => index + 1)
          .every((number) => existing.some((ticket) => ticket.ticketNumber === number));
      if (!matchesOrder || !allNumbersPresent) {
        throw new Error("Order confirmation does not match the previously issued tickets");
      }
      return;
    }

    const [cancelledEvent] = await tx.select({ cancelledAt: cancelledEventsTable.cancelledAt })
      .from(cancelledEventsTable)
      .where(eq(cancelledEventsTable.eventId, order.event.id))
      .limit(1);

    const values = Array.from({ length: order.quantity }, (_, index) => ({
      orderId: order.orderId,
      eventId: order.event.id,
      ticketNumber: index + 1,
      holderName: order.customer.name,
      eventName: order.event.name,
      eventLocation: order.event.location,
      eventStartsAt: new Date(order.event.startsAt),
      status: cancelledEvent ? "cancelled" : "active",
      issuedAt,
      updatedAt: cancelledEvent?.cancelledAt ?? issuedAt,
    }));

    for (let offset = 0; offset < values.length; offset += 500) {
      await tx.insert(ticketsTable).values(values.slice(offset, offset + 500))
        .onConflictDoNothing({ target: [ticketsTable.orderId, ticketsTable.ticketNumber] });
    }

    const saved = await tx.select({ ticketNumber: ticketsTable.ticketNumber })
      .from(ticketsTable).where(eq(ticketsTable.orderId, order.orderId));
    const savedNumbers = new Set(saved.map(({ ticketNumber }) => ticketNumber));
    if (savedNumbers.size !== order.quantity ||
      Array.from({ length: order.quantity }, (_, index) => index + 1).some((number) => !savedNumbers.has(number))) {
      throw new Error("Ticket issuance did not create the expected number of tickets");
    }
  });
}

export async function invalidateEventTickets(event: EventTicketInvalidationV1): Promise<void> {
  if (event.aggregateId !== event.data.eventId) {
    throw new Error("Event cancellation aggregate does not match its event ID");
  }
  const cancelledAt = new Date(event.occurredAt);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${event.data.eventId}, 0))`);
    await tx.insert(cancelledEventsTable).values({
      eventId: event.data.eventId,
      version: event.data.version,
      cancelledAt,
    }).onConflictDoUpdate({
      target: cancelledEventsTable.eventId,
      set: {
        version: sql`GREATEST(${cancelledEventsTable.version}, EXCLUDED.version)`,
        cancelledAt: sql`GREATEST(${cancelledEventsTable.cancelledAt}, EXCLUDED.cancelled_at)`,
      },
    });

    await tx.update(ticketsTable)
      .set({ status: "cancelled", updatedAt: cancelledAt })
      .where(and(
        eq(ticketsTable.eventId, event.data.eventId),
        eq(ticketsTable.status, "active"),
      ));
  });
}

export async function listTicketsForOrders(orderIds: string[]): Promise<TicketRecord[]> {
  if (orderIds.length === 0) return [];
  return db.select().from(ticketsTable)
    .where(inArray(ticketsTable.orderId, orderIds))
    .orderBy(asc(ticketsTable.issuedAt), asc(ticketsTable.ticketNumber));
}

export async function checkInTicket(input: TicketCheckInRequest): Promise<TicketRecord> {
  const now = new Date();
  const [updated] = await db.update(ticketsTable)
    .set({ status: "used", checkInAt: now, updatedAt: now })
    .where(and(
      eq(ticketsTable.id, input.ticketId),
      eq(ticketsTable.eventId, input.eventId),
      eq(ticketsTable.status, "active"),
    ))
    .returning();
  if (updated) return updated;

  const [current] = await db.select().from(ticketsTable)
    .where(eq(ticketsTable.id, input.ticketId)).limit(1);
  if (!current || current.eventId !== input.eventId) {
    throw new TicketCheckInError("Ticket not found", 404);
  }
  if (current.status === "used") {
    throw new TicketCheckInError("Ticket has already been checked in", 409);
  }
  throw new TicketCheckInError("Ticket is not valid for check-in", 409);
}
