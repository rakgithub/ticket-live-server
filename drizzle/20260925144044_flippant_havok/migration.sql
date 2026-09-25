CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"display_name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"description" text NOT NULL,
	"location" text NOT NULL,
	"min_people" integer NOT NULL,
	"max_people" integer NOT NULL,
	"reserved_quantity" integer DEFAULT 0 NOT NULL,
	"ticket_price_cents" integer NOT NULL,
	"currency_code" char(3) NOT NULL,
	"serves_alcohol" boolean DEFAULT false NOT NULL,
	"is_cancelled" boolean DEFAULT false NOT NULL,
	"user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "events_min_people_positive" CHECK ("min_people" > 0),
	CONSTRAINT "events_max_people_gte_min" CHECK ("max_people" >= "min_people"),
	CONSTRAINT "events_reserved_quantity_in_capacity" CHECK ("reserved_quantity" >= 0 AND "reserved_quantity" <= "max_people"),
	CONSTRAINT "events_ticket_price_nonnegative" CHECK ("ticket_price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"status" text NOT NULL,
	"ticket_price_cents" integer NOT NULL,
	"currency_code" char(3) NOT NULL,
	"total_amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_quantity_positive" CHECK ("quantity" > 0),
	CONSTRAINT "orders_status_valid" CHECK ("status" IN ('pending_payment', 'confirmed', 'cancelled', 'expired')),
	CONSTRAINT "orders_ticket_price_nonnegative" CHECK ("ticket_price_cents" >= 0),
	CONSTRAINT "orders_total_nonnegative" CHECK ("total_amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"order_id" uuid NOT NULL,
	"gateway" text NOT NULL,
	"gateway_payment_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency_code" char(3) NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_status_valid" CHECK ("status" IN ('pending', 'succeeded', 'failed', 'cancelled', 'refunded')),
	CONSTRAINT "payments_amount_nonnegative" CHECK ("amount_cents" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" ("email");--> statement-breakpoint
CREATE INDEX "events_user_id_idx" ON "events" ("user_id");--> statement-breakpoint
CREATE INDEX "events_starts_at_idx" ON "events" ("starts_at");--> statement-breakpoint
CREATE INDEX "orders_event_id_idx" ON "orders" ("event_id");--> statement-breakpoint
CREATE INDEX "orders_user_id_idx" ON "orders" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_gateway_payment_id_idx" ON "payments" ("gateway","gateway_payment_id");--> statement-breakpoint
CREATE INDEX "payments_order_id_idx" ON "payments" ("order_id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_event_id_events_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id");