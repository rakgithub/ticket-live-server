import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ticketingSchema = pgSchema("ticketing_service");

export const ticketsTable = ticketingSchema.table(
  "tickets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull(),
    eventId: uuid("event_id").notNull(),
    ticketNumber: integer("ticket_number").notNull(),
    holderName: text("holder_name").notNull(),
    eventName: text("event_name").notNull(),
    eventLocation: text("event_location").notNull(),
    eventStartsAt: timestamp("event_starts_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("active"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    checkInAt: timestamp("check_in_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("tickets_number_positive", sql`${table.ticketNumber} > 0`),
    check("tickets_status_valid", sql`${table.status} IN ('active', 'used', 'cancelled', 'refunded')`),
    check("tickets_check_in_consistent", sql`(${table.status} = 'used') = (${table.checkInAt} IS NOT NULL)`),
    uniqueIndex("tickets_order_ticket_number_idx").on(table.orderId, table.ticketNumber),
    index("tickets_event_status_idx").on(table.eventId, table.status),
    index("tickets_order_id_idx").on(table.orderId),
  ],
);

export const cancelledEventsTable = ticketingSchema.table(
  "cancelled_events",
  {
    eventId: uuid("event_id").primaryKey(),
    version: integer("version").notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }).notNull(),
  },
  (table) => [check("cancelled_events_version_positive", sql`${table.version} > 0`)],
);

export type TicketRecord = typeof ticketsTable.$inferSelect;
