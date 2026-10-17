CREATE SCHEMA IF NOT EXISTS ticketing_service AUTHORIZATION ticketlive_ticketing;
--> statement-breakpoint
ALTER SCHEMA ticketing_service OWNER TO ticketlive_ticketing;
--> statement-breakpoint
CREATE TABLE "ticketing_service"."cancelled_events" (
	"event_id" uuid PRIMARY KEY,
	"version" integer NOT NULL,
	"cancelled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cancelled_events_version_positive" CHECK ("version" > 0)
);
--> statement-breakpoint
ALTER TABLE "ticketing_service"."cancelled_events" OWNER TO ticketlive_ticketing;
--> statement-breakpoint
CREATE TABLE "ticketing_service"."tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"order_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"ticket_number" integer NOT NULL,
	"holder_name" text NOT NULL,
	"event_name" text NOT NULL,
	"event_location" text NOT NULL,
	"event_starts_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"check_in_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_number_positive" CHECK ("ticket_number" > 0),
	CONSTRAINT "tickets_status_valid" CHECK ("status" IN ('active', 'used', 'cancelled', 'refunded')),
	CONSTRAINT "tickets_check_in_consistent" CHECK (("status" = 'used') = ("check_in_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "ticketing_service"."tickets" OWNER TO ticketlive_ticketing;
--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_order_ticket_number_idx" ON "ticketing_service"."tickets" ("order_id","ticket_number");--> statement-breakpoint
CREATE INDEX "tickets_event_status_idx" ON "ticketing_service"."tickets" ("event_id","status");--> statement-breakpoint
CREATE INDEX "tickets_order_id_idx" ON "ticketing_service"."tickets" ("order_id");
