import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const orderSchema = pgSchema("order_service");

export const emailReplayAuditsTable = orderSchema.table(
  "email_replay_audits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull(),
    outboxEventId: uuid("outbox_event_id").notNull(),
    notificationKey: text("notification_key").notNull(),
    requestedBy: text("requested_by").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("started"),
    errorType: text("error_type"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    check("email_replay_audits_requested_by_not_empty", sql`length(btrim(${table.requestedBy})) > 0`),
    check("email_replay_audits_reason_not_empty", sql`length(btrim(${table.reason})) > 0`),
    check("email_replay_audits_status_valid", sql`${table.status} IN ('started', 'published', 'failed')`),
    check("email_replay_audits_error_status_valid", sql`(${table.status} = 'failed') = (${table.errorType} IS NOT NULL)`),
    index("email_replay_audits_order_requested_idx").on(table.orderId, table.requestedAt),
    index("email_replay_audits_outbox_event_idx").on(table.outboxEventId),
  ],
);

export type EmailReplayAudit = typeof emailReplayAuditsTable.$inferSelect;
export type NewEmailReplayAudit = typeof emailReplayAuditsTable.$inferInsert;
