import { and, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { env } from "../../config/env.ts";
import { db } from "../../db/client.ts";
import { eventsTable } from "../../db/schema/events.ts";
import { ordersTable } from "../../db/schema/orders.ts";
import { paymentsTable } from "../../db/schema/payments.ts";
import { mockPaymentProvider } from "../payments/mockPaymentProvider.ts";

export type CheckoutInput = {
  eventId: string;
  quantity: number;
};

export class CheckoutError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(
    message: string,
    status: 400 | 404 | 409,
  ) {
    super(message);
    this.status = status;
  }
}

export async function checkout(userId: string, input: CheckoutInput) {
  const reservation = await db.transaction(async (tx) => {
    // The conditional update makes reserving capacity safe when requests race for
    // the final available seats. It also gives us the current ticket price.
    const [event] = await tx
      .update(eventsTable)
      .set({
        reservedQuantity: sql`${eventsTable.reservedQuantity} + ${input.quantity}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(eventsTable.id, input.eventId),
          isNull(eventsTable.deletedAt),
          eq(eventsTable.isCancelled, false),
          sql`${eventsTable.reservedQuantity} + ${input.quantity} <= ${eventsTable.maxPeople}`,
        ),
      )
      .returning({
        id: eventsTable.id,
        name: eventsTable.name,
        ticketPriceCents: eventsTable.ticketPriceCents,
        currencyCode: eventsTable.currencyCode,
      });

    if (!event) {
      const [existingEvent] = await tx
        .select({
          id: eventsTable.id,
          isCancelled: eventsTable.isCancelled,
          deletedAt: eventsTable.deletedAt,
        })
        .from(eventsTable)
        .where(eq(eventsTable.id, input.eventId));

      if (!existingEvent || existingEvent.deletedAt || existingEvent.isCancelled) {
        throw new CheckoutError("Event is not available", 404);
      }

      throw new CheckoutError("Not enough seats are available", 409);
    }

    const totalAmountCents = event.ticketPriceCents * input.quantity;
    const expiresAt = new Date(
      Date.now() + env.PAYMENT_RESERVATION_TTL_SECONDS * 1_000,
    );
    const [order] = await tx
      .insert(ordersTable)
      .values({
        eventId: event.id,
        userId,
        quantity: input.quantity,
        status: "pending_payment",
        ticketPriceCents: event.ticketPriceCents,
        currencyCode: event.currencyCode,
        totalAmountCents,
        expiresAt,
      })
      .returning({
        id: ordersTable.id,
        eventId: ordersTable.eventId,
        quantity: ordersTable.quantity,
        status: ordersTable.status,
        ticketPriceCents: ordersTable.ticketPriceCents,
        currencyCode: ordersTable.currencyCode,
        totalAmountCents: ordersTable.totalAmountCents,
        expiresAt: ordersTable.expiresAt,
        createdAt: ordersTable.createdAt,
      });

    const [payment] = await tx
      .insert(paymentsTable)
      .values({
        orderId: order.id,
        gateway: "mock",
        gatewayPaymentId: randomUUID(),
        amountCents: totalAmountCents,
        currencyCode: event.currencyCode,
        status: "pending",
      })
      .returning({
        id: paymentsTable.id,
        status: paymentsTable.status,
        gateway: paymentsTable.gateway,
      });

    return { order, payment, event: { id: event.id, name: event.name } };
  });

  // This intentionally happens after the reservation transaction commits. A
  // real gateway call may take seconds and must not retain database locks.
  const paymentResult = await mockPaymentProvider.charge({
    paymentId: reservation.payment.id,
    amountCents: reservation.order.totalAmountCents,
    currencyCode: reservation.order.currencyCode,
  });

  if (paymentResult.status === "failed") {
    await failPaymentAndReleaseReservation(reservation.order.id, reservation.payment.id);
    throw new CheckoutError("Payment was declined", 409);
  }

  const confirmed = await confirmPayment(reservation.order.id, reservation.payment.id);
  return { event: reservation.event, ...confirmed };
}

async function confirmPayment(orderId: string, paymentId: string) {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .update(ordersTable)
      .set({ status: "confirmed", expiresAt: null, updatedAt: new Date() })
      .where(and(eq(ordersTable.id, orderId), eq(ordersTable.status, "pending_payment")))
      .returning({
        id: ordersTable.id,
        eventId: ordersTable.eventId,
        quantity: ordersTable.quantity,
        status: ordersTable.status,
        ticketPriceCents: ordersTable.ticketPriceCents,
        currencyCode: ordersTable.currencyCode,
        totalAmountCents: ordersTable.totalAmountCents,
        expiresAt: ordersTable.expiresAt,
        createdAt: ordersTable.createdAt,
      });

    if (!order) {
      throw new CheckoutError("Payment reservation has expired", 409);
    }

    const [payment] = await tx
      .update(paymentsTable)
      .set({ status: "succeeded", updatedAt: new Date() })
      .where(and(eq(paymentsTable.id, paymentId), eq(paymentsTable.status, "pending")))
      .returning({
        id: paymentsTable.id,
        status: paymentsTable.status,
        gateway: paymentsTable.gateway,
      });

    if (!payment) {
      throw new CheckoutError("Payment could not be confirmed", 409);
    }

    return { order, payment };
  });
}

async function failPaymentAndReleaseReservation(orderId: string, paymentId: string) {
  await db.transaction(async (tx) => {
    const [order] = await tx
      .update(ordersTable)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(ordersTable.id, orderId), eq(ordersTable.status, "pending_payment")))
      .returning({ eventId: ordersTable.eventId, quantity: ordersTable.quantity });

    if (!order) return;

    await tx
      .update(eventsTable)
      .set({
        reservedQuantity: sql`${eventsTable.reservedQuantity} - ${order.quantity}`,
        updatedAt: new Date(),
      })
      .where(eq(eventsTable.id, order.eventId));

    await tx
      .update(paymentsTable)
      .set({ status: "failed", updatedAt: new Date() })
      .where(and(eq(paymentsTable.id, paymentId), eq(paymentsTable.status, "pending")));
  });
}
