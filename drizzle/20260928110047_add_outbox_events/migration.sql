CREATE TABLE "outbox_events" (
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
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" ("processed_at","created_at");