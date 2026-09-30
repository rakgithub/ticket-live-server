import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const emailDeliveriesTable = pgTable(
  "email_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id").notNull(),
    orderId: uuid("order_id").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    status: text("status").notNull().default("simulated"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "email_deliveries_status_valid",
      sql`${table.status} IN ('simulated', 'sent', 'failed')`,
    ),
    uniqueIndex("email_deliveries_event_id_idx").on(table.eventId),
    index("email_deliveries_order_id_idx").on(table.orderId),
  ],
);

export type EmailDelivery = typeof emailDeliveriesTable.$inferSelect;
