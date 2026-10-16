import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const orderSchema = pgSchema("order_service");

export const orderOutboxEventsTable = orderSchema.table(
  "outbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventType: text("event_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
  },
  (table) => [
    check("outbox_events_attempts_nonnegative", sql`${table.attempts} >= 0`),
    index("outbox_events_pending_idx").on(table.processedAt, table.availableAt, table.createdAt),
  ],
);

export type OrderOutboxEvent = typeof orderOutboxEventsTable.$inferSelect;
export type NewOrderOutboxEvent = typeof orderOutboxEventsTable.$inferInsert;
