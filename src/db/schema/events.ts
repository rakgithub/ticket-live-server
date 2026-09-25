import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  char,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users.ts";

export const eventsTable = pgTable(
  "events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    location: text("location").notNull(),
    minPeople: integer("min_people").notNull(),
    maxPeople: integer("max_people").notNull(),
    reservedQuantity: integer("reserved_quantity").notNull().default(0),
    ticketPriceCents: integer("ticket_price_cents").notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    servesAlcohol: boolean("serves_alcohol").notNull().default(false),
    isCancelled: boolean("is_cancelled").notNull().default(false),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    check("events_min_people_positive", sql`${table.minPeople} > 0`),
    check("events_max_people_gte_min", sql`${table.maxPeople} >= ${table.minPeople}`),
    check(
      "events_reserved_quantity_in_capacity",
      sql`${table.reservedQuantity} >= 0 AND ${table.reservedQuantity} <= ${table.maxPeople}`,
    ),
    check("events_ticket_price_nonnegative", sql`${table.ticketPriceCents} >= 0`),
    index("events_user_id_idx").on(table.userId),
    index("events_starts_at_idx").on(table.startsAt),
  ],
);

export type Event = typeof eventsTable.$inferSelect;
export type NewEvent = typeof eventsTable.$inferInsert;
