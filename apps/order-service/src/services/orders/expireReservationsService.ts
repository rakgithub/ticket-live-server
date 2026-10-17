import { and, asc, eq, lte } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { checkoutAttemptsTable } from "../../db/schema/checkoutAttempts.ts";
import { orderOutboxEventsTable } from "../../db/schema/orderOutboxEvents.ts";
import { ordersTable } from "../../db/schema/orders.ts";
import { getPaymentClient, PaymentServiceError } from "../../clients/paymentServiceClient.ts";
import type { InternalPaymentRecord } from "@ticket-live/contracts";

/**
 * Expire Order-owned reservations. Event capacity changes only after the
 * release command reaches Event through the Order outbox.
 */
export async function expirePendingReservations(): Promise<number> {
  const now = new Date();
  const candidates = await db
    .select({ id: ordersTable.id })
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.status, "pending_payment"),
        lte(ordersTable.expiresAt, now),
      ),
    )
    .orderBy(asc(ordersTable.expiresAt))
    .limit(100);

  let expiredCount = 0;
  for (const { id } of candidates) {
    let payment: InternalPaymentRecord | undefined;
    try {
      payment = await getPaymentClient().getByOrder(id);
      if (payment.status === "pending") payment = await getPaymentClient().cancel(id);
    } catch (error) {
      if (!(error instanceof PaymentServiceError) || error.status !== 404) continue;
    }
    if (payment?.status === "succeeded") {
      await db.update(ordersTable)
        .set({ paymentId: payment.id, paymentStatus: payment.status, updatedAt: now })
        .where(eq(ordersTable.id, id));
      continue;
    }

    const expired = await db.transaction(async (tx) => {
      const [order] = await tx
        .select({ id: ordersTable.id, status: ordersTable.status, expiresAt: ordersTable.expiresAt })
        .from(ordersTable)
        .where(eq(ordersTable.id, id))
        .for("update");
      if (
        !order || order.status !== "pending_payment" || !order.expiresAt ||
        order.expiresAt.getTime() > now.getTime()
      ) {
        return false;
      }

      const [updated] = await tx
        .update(ordersTable)
        .set({
          status: "expired",
          paymentId: payment?.id ?? null,
          paymentStatus: payment?.status ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(ordersTable.id, order.id),
            eq(ordersTable.status, "pending_payment"),
          ),
        )
        .returning({ id: ordersTable.id });
      if (!updated) return false;

      await tx.insert(orderOutboxEventsTable).values({
        eventType: "inventory.hold.release",
        aggregateId: order.id,
        payload: { holdId: order.id, reason: "order_expired" },
      });

      await tx
        .update(checkoutAttemptsTable)
        .set({
          state: "failed",
          responseStatus: 409,
          responseBody: { error: "Payment reservation has expired" },
          updatedAt: now,
        })
        .where(
          and(
            eq(checkoutAttemptsTable.orderId, order.id),
            eq(checkoutAttemptsTable.state, "in_progress"),
          ),
        );
      return true;
    });
    if (expired) expiredCount += 1;
  }

  return expiredCount;
}
