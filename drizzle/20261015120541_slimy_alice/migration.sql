CREATE TABLE "inventory_holds" (
	"hold_id" uuid PRIMARY KEY,
	"order_id" uuid NOT NULL UNIQUE,
	"event_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"currency_code" char(3) NOT NULL,
	"event_starts_at_snapshot" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_holds_id_matches_order_id" CHECK ("hold_id" = "order_id"),
	CONSTRAINT "inventory_holds_quantity_positive" CHECK ("quantity" > 0),
	CONSTRAINT "inventory_holds_unit_price_nonnegative" CHECK ("unit_price_cents" >= 0),
	CONSTRAINT "inventory_holds_state_valid" CHECK ("state" IN ('active', 'confirmed', 'released', 'expired'))
);
--> statement-breakpoint
CREATE INDEX "inventory_holds_event_state_expiry_idx" ON "inventory_holds" ("event_id","state","expires_at");--> statement-breakpoint
ALTER TABLE "inventory_holds" ADD CONSTRAINT "inventory_holds_event_id_events_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id");