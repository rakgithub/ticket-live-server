import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { eventsTable } from "../../db/schema/events.ts";
import { ordersTable } from "../../db/schema/orders.ts";
import { paymentsTable } from "../../db/schema/payments.ts";

/** Releases seats held by checkout requests that never reached payment settlement. */
export async function expirePendingReservations(): Promise<number> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const expiredOrders = await tx
      .update(ordersTable)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(ordersTable.status, "pending_payment"),
          lte(ordersTable.expiresAt, now),
        ),
      )
      .returning({
        id: ordersTable.id,
        eventId: ordersTable.eventId,
        quantity: ordersTable.quantity,
      });

    for (const order of expiredOrders) {
      await tx
        .update(eventsTable)
        .set({
          reservedQuantity: sql`${eventsTable.reservedQuantity} - ${order.quantity}`,
          updatedAt: now,
        })
        .where(eq(eventsTable.id, order.eventId));
    }

    if (expiredOrders.length > 0) {
      await tx
        .update(paymentsTable)
        .set({ status: "cancelled", updatedAt: now })
        .where(
          and(
            inArray(
              paymentsTable.orderId,
              expiredOrders.map((order) => order.id),
            ),
            eq(paymentsTable.status, "pending"),
          ),
        );
    }

    return expiredOrders.length;
  });
}
