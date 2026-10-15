import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  char,
} from "drizzle-orm/pg-core";
import { eventsTable } from "./events.ts";

export const inventoryHoldStates = [
  "active",
  "confirmed",
  "released",
  "expired",
] as const;

export type InventoryHoldState = (typeof inventoryHoldStates)[number];

export const inventoryHoldsTable = pgTable(
  "inventory_holds",
  {
    holdId: uuid("hold_id").primaryKey(),
    orderId: uuid("order_id").notNull().unique(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => eventsTable.id),
    eventNameSnapshot: text("event_name_snapshot").notNull(),
    eventLocationSnapshot: text("event_location_snapshot").notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    eventStartsAtSnapshot: timestamp("event_starts_at_snapshot", {
      withTimezone: true,
    }).notNull(),
    state: text("state").$type<InventoryHoldState>().notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "inventory_holds_id_matches_order_id",
      sql`${table.holdId} = ${table.orderId}`,
    ),
    check("inventory_holds_quantity_positive", sql`${table.quantity} > 0`),
    check(
      "inventory_holds_unit_price_nonnegative",
      sql`${table.unitPriceCents} >= 0`,
    ),
    check(
      "inventory_holds_state_valid",
      sql`${table.state} IN ('active', 'confirmed', 'released', 'expired')`,
    ),
    index("inventory_holds_event_state_expiry_idx").on(
      table.eventId,
      table.state,
      table.expiresAt,
    ),
  ],
);

export type InventoryHold = typeof inventoryHoldsTable.$inferSelect;
export type NewInventoryHold = typeof inventoryHoldsTable.$inferInsert;
