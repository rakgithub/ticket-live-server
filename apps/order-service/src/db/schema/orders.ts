import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const orderSchema = pgSchema("order_service");

export const ordersTable = orderSchema.table(
  "orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // These IDs identify records owned by Event and Identity. Order stores the
    // IDs as values and keeps the receipt details it needs as snapshots below.
    eventId: uuid("event_id").notNull(),
    userId: uuid("user_id").notNull(),
    quantity: integer("quantity").notNull(),
    status: text("status").notNull(),
    // Checkout snapshots keep later catalog/profile changes from rewriting a receipt.
    eventNameSnapshot: text("event_name_snapshot").notNull(),
    eventLocationSnapshot: text("event_location_snapshot").notNull(),
    eventStartsAtSnapshot: timestamp("event_starts_at_snapshot", {
      withTimezone: true,
    }).notNull(),
    customerNameSnapshot: text("customer_name_snapshot").notNull(),
    customerEmailSnapshot: text("customer_email_snapshot").notNull(),
    ticketPriceCents: integer("ticket_price_cents").notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    totalAmountCents: integer("total_amount_cents").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("orders_quantity_positive", sql`${table.quantity} > 0`),
    check(
      "orders_status_valid",
      sql`${table.status} IN ('initiated', 'held', 'pending_payment', 'confirmed', 'cancelled', 'expired', 'reconciliation_required')`,
    ),
    check("orders_ticket_price_nonnegative", sql`${table.ticketPriceCents} >= 0`),
    check("orders_total_nonnegative", sql`${table.totalAmountCents} >= 0`),
    index("orders_event_id_idx").on(table.eventId),
    index("orders_user_id_idx").on(table.userId),
  ],
);

export type Order = typeof ordersTable.$inferSelect;
export type NewOrder = typeof ordersTable.$inferInsert;
