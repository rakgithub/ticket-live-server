import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { ordersTable } from "./orders.ts";

const orderSchema = pgSchema("order_service");

export const checkoutAttemptsTable = orderSchema.table(
  "checkout_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // user_id is an Identity-owned ID, so it intentionally has no foreign key.
    userId: uuid("user_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    orderId: uuid("order_id"),
    state: text("state").notNull().default("in_progress"),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("checkout_attempts_user_key_idx").on(
      table.userId,
      table.idempotencyKey,
    ),
    uniqueIndex("checkout_attempts_order_id_idx").on(table.orderId),
    index("checkout_attempts_state_updated_idx").on(table.state, table.updatedAt),
    check(
      "checkout_attempts_key_not_empty",
      sql`length(btrim(${table.idempotencyKey})) BETWEEN 1 AND 255`,
    ),
    check(
      "checkout_attempts_request_hash_sha256",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "checkout_attempts_state_valid",
      sql`${table.state} IN ('in_progress', 'succeeded', 'failed')`,
    ),
    check(
      "checkout_attempts_response_valid",
      sql`(${table.state} = 'in_progress' AND ${table.responseStatus} IS NULL AND ${table.responseBody} IS NULL) OR (${table.state} IN ('succeeded', 'failed') AND ${table.responseStatus} IS NOT NULL AND ${table.responseBody} IS NOT NULL)`,
    ),
    check(
      "checkout_attempts_response_status_valid",
      sql`${table.responseStatus} IS NULL OR ${table.responseStatus} BETWEEN 200 AND 599`,
    ),
    foreignKey({
      name: "checkout_attempts_order_id_orders_id_fkey",
      columns: [table.orderId],
      foreignColumns: [ordersTable.id],
    }),
  ],
);

export type CheckoutAttempt = typeof checkoutAttemptsTable.$inferSelect;
