import { desc, eq } from "drizzle-orm";
import {
  OrderListResponseSchema,
  type OrderListResponse,
} from "@ticket-live/contracts";
import { db } from "../../db/client.ts";
import { ordersTable } from "../../db/schema/orders.ts";

export async function listOrdersForUser(userId: string): Promise<OrderListResponse> {
  const rows = await db
    .select({
      id: ordersTable.id,
      eventId: ordersTable.eventId,
      eventName: ordersTable.eventNameSnapshot,
      eventLocation: ordersTable.eventLocationSnapshot,
      eventStartsAt: ordersTable.eventStartsAtSnapshot,
      quantity: ordersTable.quantity,
      status: ordersTable.status,
      ticketPriceCents: ordersTable.ticketPriceCents,
      currencyCode: ordersTable.currencyCode,
      totalAmountCents: ordersTable.totalAmountCents,
      expiresAt: ordersTable.expiresAt,
      paymentStatus: ordersTable.paymentStatus,
      createdAt: ordersTable.createdAt,
    })
    .from(ordersTable)
    .where(eq(ordersTable.userId, userId))
    .orderBy(desc(ordersTable.createdAt), desc(ordersTable.id));

  return OrderListResponseSchema.parse({
    orders: rows.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      event: {
        name: row.eventName,
        location: row.eventLocation,
        startsAt: row.eventStartsAt.toISOString(),
      },
      quantity: row.quantity,
      status: row.status,
      ticketPriceCents: row.ticketPriceCents,
      currencyCode: row.currencyCode.trim(),
      totalAmountCents: row.totalAmountCents,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      paymentStatus: row.paymentStatus,
      createdAt: row.createdAt.toISOString(),
    })),
  });
}
