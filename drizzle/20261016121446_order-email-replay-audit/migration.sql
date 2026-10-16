CREATE TABLE "order_service"."email_replay_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"order_id" uuid NOT NULL,
	"outbox_event_id" uuid NOT NULL,
	"notification_key" text NOT NULL,
	"requested_by" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"error_type" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "email_replay_audits_requested_by_not_empty" CHECK (length(btrim("requested_by")) > 0),
	CONSTRAINT "email_replay_audits_reason_not_empty" CHECK (length(btrim("reason")) > 0),
	CONSTRAINT "email_replay_audits_status_valid" CHECK ("status" IN ('started', 'published', 'failed')),
	CONSTRAINT "email_replay_audits_error_status_valid" CHECK (("status" = 'failed') = ("error_type" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "email_replay_audits_order_requested_idx" ON "order_service"."email_replay_audits" ("order_id","requested_at");--> statement-breakpoint
CREATE INDEX "email_replay_audits_outbox_event_idx" ON "order_service"."email_replay_audits" ("outbox_event_id");--> statement-breakpoint
ALTER TABLE "order_service"."email_replay_audits" OWNER TO ticketlive_order;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "order_service"."email_replay_audits" TO ticketlive_order, ticketlive_public_api;
