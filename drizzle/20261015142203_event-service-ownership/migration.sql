CREATE SCHEMA IF NOT EXISTS "event_service" AUTHORIZATION ticketlive_event;--> statement-breakpoint
ALTER TABLE "public"."events" DROP CONSTRAINT "events_user_id_users_id_fkey";--> statement-breakpoint
ALTER TABLE "public"."events" SET SCHEMA "event_service";--> statement-breakpoint
ALTER TABLE "public"."inventory_holds" SET SCHEMA "event_service";--> statement-breakpoint
ALTER TABLE "public"."outbox_events" SET SCHEMA "event_service";--> statement-breakpoint
ALTER TABLE "event_service"."events" OWNER TO ticketlive_event;--> statement-breakpoint
ALTER TABLE "event_service"."inventory_holds" OWNER TO ticketlive_event;--> statement-breakpoint
ALTER TABLE "event_service"."outbox_events" OWNER TO ticketlive_event;--> statement-breakpoint
GRANT USAGE ON SCHEMA "event_service" TO ticketlive_event;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "event_service" TO ticketlive_event;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "event_service" TO ticketlive_event;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "event_service" FROM ticketlive_public_api;
