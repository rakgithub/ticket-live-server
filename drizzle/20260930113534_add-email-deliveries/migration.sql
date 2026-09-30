CREATE TABLE "email_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"event_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"recipient_email" text NOT NULL,
	"status" text DEFAULT 'simulated' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_deliveries_status_valid" CHECK ("status" IN ('simulated', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_event_id_idx" ON "email_deliveries" ("event_id");--> statement-breakpoint
CREATE INDEX "email_deliveries_order_id_idx" ON "email_deliveries" ("order_id");