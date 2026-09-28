import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { eventsTable } from "./events.ts";
import { usersTable } from "./users.ts";

export const ordersTable = pgTable(
  "orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => eventsTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id),
    quantity: integer("quantity").notNull(),
    status: text("status").notNull(),
    // Price snapshot: event price changes must not alter existing orders.
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
      sql`${table.status} IN ('pending_payment', 'confirmed', 'cancelled', 'expired')`,
    ),
    check("orders_ticket_price_nonnegative", sql`${table.ticketPriceCents} >= 0`),
    check("orders_total_nonnegative", sql`${table.totalAmountCents} >= 0`),
    index("orders_event_id_idx").on(table.eventId),
    index("orders_user_id_idx").on(table.userId),
  ],
);

export type Order = typeof ordersTable.$inferSelect;
export type NewOrder = typeof ordersTable.$inferInsert;
