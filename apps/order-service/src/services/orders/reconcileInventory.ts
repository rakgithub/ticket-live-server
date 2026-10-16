import { and, asc, gt, inArray } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { ordersTable } from "../../db/schema/orders.ts";
import { createLogger } from "@ticket-live/runtime";
import { getInventoryClient, InventoryServiceError } from "../../clients/eventInventoryClient.ts";

const logger = createLogger("ticket-live-order-inventory-reconciliation");
let lastOrderId = "00000000-0000-0000-0000-000000000000";
let paymentHoldMismatchTotal = 0;

export function getPaymentHoldMismatchTotal(): number {
  return paymentHoldMismatchTotal;
}

/** Compare bounded Order snapshots with Event's read API; never join Event tables. */
export async function reconcileOrderInventory(): Promise<number> {
  let orders = await db.select({
    id: ordersTable.id,
    eventId: ordersTable.eventId,
    quantity: ordersTable.quantity,
    status: ordersTable.status,
  }).from(ordersTable)
    .where(and(gt(ordersTable.id, lastOrderId), inArray(ordersTable.status, ["held", "pending_payment", "confirmed"])))
    .orderBy(asc(ordersTable.id)).limit(25);
  if (orders.length === 0 && lastOrderId !== "00000000-0000-0000-0000-000000000000") {
    lastOrderId = "00000000-0000-0000-0000-000000000000";
    orders = await db.select({ id: ordersTable.id, eventId: ordersTable.eventId, quantity: ordersTable.quantity, status: ordersTable.status })
      .from(ordersTable).where(inArray(ordersTable.status, ["held", "pending_payment", "confirmed"]))
      .orderBy(asc(ordersTable.id)).limit(25);
  }
  const inventory = getInventoryClient();
  let mismatches = 0;

  for (const order of orders) {
    lastOrderId = order.id;
    try {
      const { hold } = await inventory.getHold(order.id);
      const stateMatches = order.status === "confirmed"
        ? hold.state === "confirmed"
        : hold.state === "active" || (order.status === "pending_payment" && hold.state === "confirmed");
      if (hold.eventId !== order.eventId || hold.quantity !== order.quantity || !stateMatches) {
        mismatches += 1;
        paymentHoldMismatchTotal += 1;
        logger.error("Order and Event inventory state differ", {
          orderId: order.id,
          orderStatus: order.status,
          holdState: hold.state,
          eventIdMatches: hold.eventId === order.eventId,
          quantityMatches: hold.quantity === order.quantity,
        });
      }
    } catch (error) {
      if (error instanceof InventoryServiceError && error.status === 404) {
        mismatches += 1;
        paymentHoldMismatchTotal += 1;
        logger.error("Order has no Event inventory hold", { orderId: order.id, orderStatus: order.status });
      } else {
        throw error;
      }
    }
  }
  if (mismatches > 0) logger.error("Order inventory reconciliation found drift", { examined: orders.length, mismatches });
  return mismatches;
}
