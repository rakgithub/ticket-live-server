ALTER TABLE "order_service"."checkout_attempts" DROP CONSTRAINT "checkout_attempts_order_id_orders_id_fkey";--> statement-breakpoint
ALTER TABLE "inventory_holds" ADD COLUMN "event_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "inventory_holds" ADD COLUMN "event_location_snapshot" text;--> statement-breakpoint
UPDATE "inventory_holds" AS holds SET "event_name_snapshot" = events."name", "event_location_snapshot" = events."location" FROM "public"."events" AS events WHERE events."id" = holds."event_id";--> statement-breakpoint
ALTER TABLE "inventory_holds" ALTER COLUMN "event_name_snapshot" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_holds" ALTER COLUMN "event_location_snapshot" SET NOT NULL;
