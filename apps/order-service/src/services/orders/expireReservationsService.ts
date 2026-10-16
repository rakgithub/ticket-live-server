import { and, asc, eq, lte } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { checkoutAttemptsTable } from "../../db/schema/checkoutAttempts.ts";
import { orderOutboxEventsTable } from "../../db/schema/orderOutboxEvents.ts";
import { ordersTable } from "../../db/schema/orders.ts";
import { paymentsTable } from "../../db/schema/payments.ts";

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

      const [payment] = await tx
        .select({ id: paymentsTable.id, status: paymentsTable.status })
        .from(paymentsTable)
        .where(eq(paymentsTable.orderId, order.id))
        .for("update");
      if (payment?.status === "succeeded") return false;

      const [updated] = await tx
        .update(ordersTable)
        .set({ status: "expired", updatedAt: now })
        .where(
          and(
            eq(ordersTable.id, order.id),
            eq(ordersTable.status, "pending_payment"),
          ),
        )
        .returning({ id: ordersTable.id });
      if (!updated) return false;

      if (payment?.status === "pending") {
        await tx
          .update(paymentsTable)
          .set({ status: "cancelled", updatedAt: now })
          .where(
            and(
              eq(paymentsTable.id, payment.id),
              eq(paymentsTable.status, "pending"),
            ),
          );
      }

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
