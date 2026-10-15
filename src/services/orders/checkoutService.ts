import { CheckoutResponseSchema, type CheckoutResponse } from "@ticket-live/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { env } from "../../config/env.ts";
import { db } from "../../db/client.ts";
import { checkoutAttemptsTable } from "../../db/schema/checkoutAttempts.ts";
import { eventsTable } from "../../db/schema/events.ts";
import { orderOutboxEventsTable } from "../../db/schema/orderOutboxEvents.ts";
import { ordersTable } from "../../db/schema/orders.ts";
import { paymentsTable } from "../../db/schema/payments.ts";
import { usersTable } from "../../db/schema/users.ts";
import { withTraceMetadata } from "../../observability/traceContext.ts";
import { mockPaymentProvider } from "../payments/mockPaymentProvider.ts";

export type CheckoutInput = {
  eventId: string;
  quantity: number;
};

export class CheckoutError extends Error {
  readonly status: 400 | 404 | 409 | 500;

  constructor(
    message: string,
    status: 400 | 404 | 409 | 500,
  ) {
    super(message);
    this.status = status;
  }
}

export async function checkout(
  userId: string,
  input: CheckoutInput,
  idempotencyKey: string,
): Promise<CheckoutResponse> {
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ eventId: input.eventId, quantity: input.quantity }))
    .digest("hex");
  const attempt = await beginCheckoutAttempt(userId, idempotencyKey, requestHash);

  if (!attempt.created) {
    if (attempt.requestHash !== requestHash) {
      throw new CheckoutError(
        "This Idempotency-Key was already used with different checkout details",
        409,
      );
    }

    if (attempt.state === "succeeded") {
      if (!attempt.responseBody) throw new Error("Successful checkout attempt has no saved response");
      return CheckoutResponseSchema.parse(attempt.responseBody);
    }

    if (attempt.state === "failed") {
      const responseBody = attempt.responseBody;
      const message = responseBody && typeof responseBody.error === "string"
        ? responseBody.error
        : "Checkout did not complete";
      if (
        attempt.responseStatus !== 400 &&
        attempt.responseStatus !== 404 &&
        attempt.responseStatus !== 409 &&
        attempt.responseStatus !== 500
      ) {
        throw new Error("Failed checkout attempt has an invalid saved status");
      }
      throw new CheckoutError(message, attempt.responseStatus);
    }

    throw new CheckoutError(
      "A checkout using this Idempotency-Key is still being processed; retry with the same key",
      409,
    );
  }

  let orderId: string | undefined;
  try {
    const reservation = await db.transaction(async (tx) => {
      // Keep the existing atomic seat check while Order and Event still run in
      // the same application. The event and customer fields copied below are
      // the receipt snapshot; later catalog/profile edits cannot change it.
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
          location: eventsTable.location,
          startsAt: eventsTable.startsAt,
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

      const [customer] = await tx
        .select({
          name: usersTable.displayName,
          email: usersTable.email,
        })
        .from(usersTable)
        .where(eq(usersTable.id, userId));

      if (!customer) throw new CheckoutError("Customer account is not available", 404);

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
          eventNameSnapshot: event.name,
          eventLocationSnapshot: event.location,
          eventStartsAtSnapshot: event.startsAt,
          customerNameSnapshot: customer.name,
          customerEmailSnapshot: customer.email,
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

      await tx
        .update(checkoutAttemptsTable)
        .set({ orderId: order.id, updatedAt: new Date() })
        .where(eq(checkoutAttemptsTable.id, attempt.id));

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

      return {
        order,
        payment,
        event: { id: event.id, name: event.name },
      };
    });

    orderId = reservation.order.id;

    // This intentionally happens after the reservation transaction commits. A
    // real gateway call may take seconds and must not retain database locks.
    const paymentResult = await mockPaymentProvider.charge({
      paymentId: reservation.payment.id,
      amountCents: reservation.order.totalAmountCents,
      currencyCode: reservation.order.currencyCode,
    });

    if (paymentResult.status === "failed") {
      const failure = new CheckoutError("Payment was declined", 409);
      await failPaymentAndReleaseReservation(
        reservation.order.id,
        reservation.payment.id,
        attempt.id,
        failure,
      );
      throw failure;
    }

    return await confirmPayment(reservation.order.id, reservation.payment.id, attempt.id);
  } catch (error) {
    if (error instanceof CheckoutError) {
      // Business failures are part of the idempotent result too: the same key
      // gets the same status and message on a retry.
      await saveFailedAttempt(attempt.id, error, orderId);
    } else {
      // If the request reaches the API's generic 500 response, save that result
      // too so a retry cannot repeat a payment or create another order.
      await saveFailedAttempt(
        attempt.id,
        new CheckoutError("Internal server error", 500),
        orderId,
      );
    }
    throw error;
  }
}

async function beginCheckoutAttempt(
  userId: string,
  idempotencyKey: string,
  requestHash: string,
) {
  const [created] = await db
    .insert(checkoutAttemptsTable)
    .values({ userId, idempotencyKey, requestHash })
    .onConflictDoNothing({
      target: [checkoutAttemptsTable.userId, checkoutAttemptsTable.idempotencyKey],
    })
    .returning({ id: checkoutAttemptsTable.id });

  if (created) {
    return {
      id: created.id,
      requestHash,
      state: "in_progress",
      responseStatus: null,
      responseBody: null,
      created: true,
    };
  }

  const [existing] = await db
    .select({
      id: checkoutAttemptsTable.id,
      requestHash: checkoutAttemptsTable.requestHash,
      state: checkoutAttemptsTable.state,
      responseStatus: checkoutAttemptsTable.responseStatus,
      responseBody: checkoutAttemptsTable.responseBody,
    })
    .from(checkoutAttemptsTable)
    .where(
      and(
        eq(checkoutAttemptsTable.userId, userId),
        eq(checkoutAttemptsTable.idempotencyKey, idempotencyKey),
      ),
    );

  if (!existing) throw new Error("Checkout idempotency record could not be loaded");
  return { ...existing, created: false };
}

async function saveFailedAttempt(
  attemptId: string,
  error: CheckoutError,
  orderId?: string,
): Promise<void> {
  await db
    .update(checkoutAttemptsTable)
    .set({
      ...(orderId ? { orderId } : {}),
      state: "failed",
      responseStatus: error.status,
      responseBody: { error: error.message },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(checkoutAttemptsTable.id, attemptId),
        eq(checkoutAttemptsTable.state, "in_progress"),
      ),
    );
}

async function confirmPayment(
  orderId: string,
  paymentId: string,
  attemptId: string,
): Promise<CheckoutResponse> {
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
        eventNameSnapshot: ordersTable.eventNameSnapshot,
        eventLocationSnapshot: ordersTable.eventLocationSnapshot,
        eventStartsAtSnapshot: ordersTable.eventStartsAtSnapshot,
        customerNameSnapshot: ordersTable.customerNameSnapshot,
        customerEmailSnapshot: ordersTable.customerEmailSnapshot,
        ticketPriceCents: ordersTable.ticketPriceCents,
        currencyCode: ordersTable.currencyCode,
        totalAmountCents: ordersTable.totalAmountCents,
        expiresAt: ordersTable.expiresAt,
        createdAt: ordersTable.createdAt,
      });

    if (!order) throw new CheckoutError("Payment reservation has expired", 409);

    const [payment] = await tx
      .update(paymentsTable)
      .set({ status: "succeeded", updatedAt: new Date() })
      .where(and(eq(paymentsTable.id, paymentId), eq(paymentsTable.status, "pending")))
      .returning({
        id: paymentsTable.id,
        status: paymentsTable.status,
        gateway: paymentsTable.gateway,
      });

    if (!payment) throw new CheckoutError("Payment could not be confirmed", 409);

    const response = CheckoutResponseSchema.parse({
      event: { id: order.eventId, name: order.eventNameSnapshot },
      order: {
        id: order.id,
        eventId: order.eventId,
        quantity: order.quantity,
        status: order.status,
        ticketPriceCents: order.ticketPriceCents,
        currencyCode: order.currencyCode,
        totalAmountCents: order.totalAmountCents,
        expiresAt: order.expiresAt,
        createdAt: order.createdAt.toISOString(),
      },
      payment,
    });

    await tx.insert(orderOutboxEventsTable).values({
      eventType: "order.confirmed",
      aggregateId: order.id,
      payload: withTraceMetadata({
        orderId: order.id,
        customer: {
          name: order.customerNameSnapshot,
          email: order.customerEmailSnapshot,
        },
        event: {
          id: order.eventId,
          name: order.eventNameSnapshot,
          location: order.eventLocationSnapshot,
          startsAt: order.eventStartsAtSnapshot.toISOString(),
        },
        quantity: order.quantity,
        ticketPriceCents: order.ticketPriceCents,
        totalAmountCents: order.totalAmountCents,
        currencyCode: order.currencyCode,
      }),
    });

    await tx
      .update(checkoutAttemptsTable)
      .set({
        orderId: order.id,
        state: "succeeded",
        responseStatus: 201,
        responseBody: response as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(checkoutAttemptsTable.id, attemptId));

    return response;
  });
}

async function failPaymentAndReleaseReservation(
  orderId: string,
  paymentId: string,
  attemptId: string,
  failure: CheckoutError,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [order] = await tx
      .update(ordersTable)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(ordersTable.id, orderId), eq(ordersTable.status, "pending_payment")))
      .returning({ eventId: ordersTable.eventId, quantity: ordersTable.quantity });

    if (order) {
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
    }

    await tx
      .update(checkoutAttemptsTable)
      .set({
        orderId,
        state: "failed",
        responseStatus: failure.status,
        responseBody: { error: failure.message },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(checkoutAttemptsTable.id, attemptId),
          eq(checkoutAttemptsTable.state, "in_progress"),
        ),
      );
  });
}
