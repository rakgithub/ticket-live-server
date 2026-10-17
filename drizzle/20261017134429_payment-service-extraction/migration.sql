CREATE SCHEMA IF NOT EXISTS payment_service AUTHORIZATION ticketlive_payment;
--> statement-breakpoint
ALTER TABLE "order_service"."orders"
	ADD COLUMN "payment_id" uuid,
	ADD COLUMN "payment_status" text;
--> statement-breakpoint
UPDATE "order_service"."orders" AS orders
SET "payment_id" = payments."id", "payment_status" = payments."status"
FROM "order_service"."payments" AS payments
WHERE payments."order_id" = orders."id";
--> statement-breakpoint
ALTER TABLE "order_service"."orders"
	ADD CONSTRAINT "orders_payment_status_valid"
	CHECK ("payment_status" IS NULL OR "payment_status" IN ('pending', 'succeeded', 'failed', 'cancelled', 'refunded'));
--> statement-breakpoint
ALTER TABLE "order_service"."payments"	DROP CONSTRAINT "payments_order_id_orders_id_fkey";
--> statement-breakpoint
ALTER TABLE "order_service"."payments" SET SCHEMA "payment_service";
--> statement-breakpoint
DROP INDEX "payment_service"."payments_order_id_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_order_id_idx" ON "payment_service"."payments" ("order_id");
--> statement-breakpoint
ALTER SCHEMA "payment_service" OWNER TO ticketlive_payment;
--> statement-breakpoint
ALTER TABLE "payment_service"."payments" OWNER TO ticketlive_payment;
