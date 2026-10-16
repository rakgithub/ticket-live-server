import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgSchema,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const emailSchema = pgSchema("email_service");

export const emailDeliveriesTable = emailSchema.table(
  "email_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id").notNull(),
    notificationKey: text("notification_key").notNull(),
    orderId: uuid("order_id").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    status: text("status").notNull().default("queued"),
    providerName: text("provider_name"),
    providerMessageId: text("provider_message_id"),
    providerAcceptedAt: timestamp("provider_accepted_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
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
      sql`${table.status} IN ('queued', 'sending', 'accepted_by_provider', 'delivered', 'bounced', 'failed', 'simulated')`,
    ),
    check("email_deliveries_attempts_nonnegative", sql`${table.attempts} >= 0`),
    uniqueIndex("email_deliveries_event_id_idx").on(table.eventId),
    uniqueIndex("email_deliveries_notification_key_idx").on(table.notificationKey),
    index("email_deliveries_order_id_idx").on(table.orderId),
  ],
);

export type EmailDelivery = typeof emailDeliveriesTable.$inferSelect;
