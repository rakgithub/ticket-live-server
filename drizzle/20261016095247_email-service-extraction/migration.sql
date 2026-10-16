CREATE SCHEMA IF NOT EXISTS "email_service" AUTHORIZATION ticketlive_email;--> statement-breakpoint
ALTER SCHEMA "email_service" OWNER TO ticketlive_email;--> statement-breakpoint
ALTER TABLE "email_deliveries" SET SCHEMA "email_service";
--> statement-breakpoint
ALTER TABLE "email_service"."email_deliveries" ADD COLUMN "provider_name" text;--> statement-breakpoint
ALTER TABLE "email_service"."email_deliveries" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "email_service"."email_deliveries" ADD COLUMN "provider_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_service"."email_deliveries" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_service"."email_deliveries" ADD COLUMN "bounced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_service"."email_deliveries" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_service"."email_deliveries" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_service"."email_deliveries" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "email_service"."email_deliveries" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_service"."email_deliveries" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "email_service"."email_deliveries" DROP CONSTRAINT "email_deliveries_status_valid";--> statement-breakpoint
UPDATE "email_service"."email_deliveries"
SET "status" = CASE
  WHEN "status" = 'sent' THEN 'accepted_by_provider'
  ELSE "status"
END,
"provider_name" = CASE
  WHEN "status" = 'sent' THEN 'legacy'
  WHEN "status" = 'simulated' THEN 'legacy-simulation'
  ELSE "provider_name"
END,
"provider_accepted_at" = CASE
  WHEN "status" = 'sent' THEN "updated_at"
  ELSE "provider_accepted_at"
END,
"failed_at" = CASE
  WHEN "status" = 'failed' THEN "updated_at"
  ELSE "failed_at"
END;--> statement-breakpoint
ALTER TABLE "email_service"."email_deliveries" ALTER COLUMN "status" SET DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE "email_service"."email_deliveries" ADD CONSTRAINT "email_deliveries_attempts_nonnegative" CHECK ("attempts" >= 0);--> statement-breakpoint
ALTER TABLE "email_service"."email_deliveries" ADD CONSTRAINT "email_deliveries_status_valid" CHECK ("status" IN ('queued', 'sending', 'accepted_by_provider', 'delivered', 'bounced', 'failed', 'simulated'));--> statement-breakpoint
ALTER TABLE "email_service"."email_deliveries" OWNER TO ticketlive_email;--> statement-breakpoint
GRANT USAGE ON SCHEMA "email_service" TO ticketlive_email;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "email_service"."email_deliveries" TO ticketlive_email;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "email_service"."email_deliveries" FROM ticketlive_public_api;
