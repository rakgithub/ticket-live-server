import { sql } from "drizzle-orm";
import { check, char, integer, pgSchema, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const paymentSchema = pgSchema("payment_service");

export const paymentsTable = paymentSchema.table(
  "payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull(),
    gateway: text("gateway").notNull(),
    gatewayPaymentId: text("gateway_payment_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("payments_status_valid", sql`${table.status} IN ('pending', 'succeeded', 'failed', 'cancelled', 'refunded')`),
    check("payments_amount_nonnegative", sql`${table.amountCents} >= 0`),
    uniqueIndex("payments_gateway_payment_id_idx").on(table.gateway, table.gatewayPaymentId),
    uniqueIndex("payments_order_id_idx").on(table.orderId),
  ],
);
