ALTER TABLE "outbox_events" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "order_service"."outbox_events" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD COLUMN "notification_key" text;--> statement-breakpoint
WITH ranked_deliveries AS (
	SELECT "id", "order_id", "event_id", row_number() OVER (
		PARTITION BY "order_id" ORDER BY "created_at", "id"
	) AS row_number
	FROM "email_deliveries"
)
UPDATE "email_deliveries" AS deliveries
SET "notification_key" = CASE
	WHEN ranked_deliveries.row_number = 1
		THEN 'order-confirmation:' || ranked_deliveries."order_id"::text
	ELSE 'legacy-order-confirmation:' || ranked_deliveries."order_id"::text || ':' || ranked_deliveries."event_id"::text
END
FROM ranked_deliveries
WHERE deliveries."id" = ranked_deliveries."id";--> statement-breakpoint
ALTER TABLE "email_deliveries" ALTER COLUMN "notification_key" SET NOT NULL;--> statement-breakpoint
DROP INDEX "outbox_events_pending_idx";--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" ("processed_at","available_at","created_at");--> statement-breakpoint
DROP INDEX "order_service"."outbox_events_pending_idx";--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "order_service"."outbox_events" ("processed_at","available_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_notification_key_idx" ON "email_deliveries" ("notification_key");
