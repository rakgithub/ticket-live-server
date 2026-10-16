ALTER TABLE "event_service"."events" ADD COLUMN "baseline_sold_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
WITH baseline AS (
  SELECT orders.event_id, COALESCE(SUM(orders.quantity), 0)::integer AS quantity
  FROM "order_service"."orders" AS orders
  LEFT JOIN "event_service"."inventory_holds" AS holds
    ON holds.order_id = orders.id AND holds.state = 'confirmed'
  WHERE orders.status = 'confirmed' AND holds.order_id IS NULL
  GROUP BY orders.event_id
), held_or_sold AS (
  SELECT event_id, COALESCE(SUM(quantity), 0)::integer AS quantity
  FROM "event_service"."inventory_holds"
  WHERE state IN ('active', 'confirmed')
  GROUP BY event_id
), occupancy AS (
  SELECT events.id,
         COALESCE(baseline.quantity, 0)::integer AS baseline_quantity,
         COALESCE(held_or_sold.quantity, 0)::integer AS held_or_sold_quantity
  FROM "event_service"."events" AS events
  LEFT JOIN baseline ON baseline.event_id = events.id
  LEFT JOIN held_or_sold ON held_or_sold.event_id = events.id
)
UPDATE "event_service"."events" AS events
SET baseline_sold_quantity = occupancy.baseline_quantity,
    reserved_quantity = occupancy.baseline_quantity + occupancy.held_or_sold_quantity,
    updated_at = now()
FROM occupancy
WHERE events.id = occupancy.id;--> statement-breakpoint
ALTER TABLE "event_service"."events" ADD CONSTRAINT "events_baseline_sold_nonnegative" CHECK ("baseline_sold_quantity" >= 0);
