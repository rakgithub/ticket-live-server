CREATE SCHEMA IF NOT EXISTS order_service AUTHORIZATION ticketlive_order;
--> statement-breakpoint
-- Store receipt details on the order before removing its links to Event and Identity.
ALTER TABLE "public"."orders"
	ADD COLUMN "event_name_snapshot" text,
	ADD COLUMN "event_location_snapshot" text,
	ADD COLUMN "event_starts_at_snapshot" timestamp with time zone,
	ADD COLUMN "customer_name_snapshot" text,
	ADD COLUMN "customer_email_snapshot" text;
--> statement-breakpoint
UPDATE "public"."orders" AS orders
SET
	"event_name_snapshot" = events."name",
	"event_location_snapshot" = events."location",
	"event_starts_at_snapshot" = events."starts_at",
	"customer_name_snapshot" = users."display_name",
	"customer_email_snapshot" = users."email"
FROM "public"."events" AS events, "public"."users" AS users
WHERE orders."event_id" = events."id" AND orders."user_id" = users."id";
--> statement-breakpoint
ALTER TABLE "public"."orders"
	ALTER COLUMN "event_name_snapshot" SET NOT NULL,
	ALTER COLUMN "event_location_snapshot" SET NOT NULL,
	ALTER COLUMN "event_starts_at_snapshot" SET NOT NULL,
	ALTER COLUMN "customer_name_snapshot" SET NOT NULL,
	ALTER COLUMN "customer_email_snapshot" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."orders" DROP CONSTRAINT "orders_event_id_events_id_fkey";
--> statement-breakpoint
ALTER TABLE "public"."orders" DROP CONSTRAINT "orders_user_id_users_id_fkey";
--> statement-breakpoint
ALTER TABLE "public"."orders" SET SCHEMA "order_service";
--> statement-breakpoint
ALTER TABLE "public"."payments" SET SCHEMA "order_service";
--> statement-breakpoint
ALTER TABLE "order_service"."orders"
	DROP CONSTRAINT "orders_status_valid",
	ADD CONSTRAINT "orders_status_valid" CHECK ("status" IN (
		'initiated', 'held', 'pending_payment', 'confirmed', 'cancelled', 'expired', 'reconciliation_required'
	));
--> statement-breakpoint
CREATE TABLE "order_service"."checkout_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"order_id" uuid,
	"state" text DEFAULT 'in_progress' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_attempts_key_not_empty" CHECK (length(btrim("idempotency_key")) BETWEEN 1 AND 255),
	CONSTRAINT "checkout_attempts_request_hash_sha256" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "checkout_attempts_state_valid" CHECK ("state" IN ('in_progress', 'succeeded', 'failed')),
	CONSTRAINT "checkout_attempts_response_valid" CHECK (
		("state" = 'in_progress' AND "response_status" IS NULL AND "response_body" IS NULL)
		OR ("state" IN ('succeeded', 'failed') AND "response_status" IS NOT NULL AND "response_body" IS NOT NULL)
	),
	CONSTRAINT "checkout_attempts_response_status_valid" CHECK ("response_status" IS NULL OR "response_status" BETWEEN 200 AND 599),
	CONSTRAINT "checkout_attempts_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order_service"."orders"("id")
);
--> statement-breakpoint
CREATE TABLE "order_service"."outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"event_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "outbox_events_attempts_nonnegative" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
INSERT INTO "order_service"."outbox_events" (
	"id", "event_type", "aggregate_id", "payload", "created_at", "processed_at", "attempts", "last_error"
)
SELECT
	"id", "event_type", "aggregate_id", "payload", "created_at", "processed_at", "attempts", "last_error"
FROM "public"."outbox_events"
WHERE "event_type" = 'order.confirmed';
--> statement-breakpoint
DELETE FROM "public"."outbox_events" WHERE "event_type" = 'order.confirmed';
--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_attempts_user_key_idx" ON "order_service"."checkout_attempts" ("user_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_attempts_order_id_idx" ON "order_service"."checkout_attempts" ("order_id");
--> statement-breakpoint
CREATE INDEX "checkout_attempts_state_updated_idx" ON "order_service"."checkout_attempts" ("state", "updated_at");
--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "order_service"."outbox_events" ("processed_at", "created_at");
--> statement-breakpoint
ALTER TABLE "order_service"."orders" OWNER TO ticketlive_order;
--> statement-breakpoint
ALTER TABLE "order_service"."payments" OWNER TO ticketlive_order;
--> statement-breakpoint
ALTER TABLE "order_service"."checkout_attempts" OWNER TO ticketlive_order;
--> statement-breakpoint
ALTER TABLE "order_service"."outbox_events" OWNER TO ticketlive_order;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "order_service" TO ticketlive_order, ticketlive_public_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "order_service" TO ticketlive_order, ticketlive_public_api;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "order_service" TO ticketlive_order, ticketlive_public_api;
