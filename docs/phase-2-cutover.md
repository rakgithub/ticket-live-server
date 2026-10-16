# Phase 2 Event and inventory cutover

Use this runbook to move catalog and hold ownership to Event. The schema and
runtime changes are prepared in the repository; applying migrations and
switching a live deployment remain operator actions.

## Prepare and reconcile

1. Confirm the Event service is deployed with its own `EVENT_SERVICE_DATABASE_URL`
   using the `ticketlive_event` role, Elasticsearch access, and the internal
   service token. Do not inject that database URL into the Order or public API
   process.
2. Take a recoverable PostgreSQL snapshot and record the database version,
   migration position, Event/Order deployment versions, and current RabbitMQ
   queue state.
3. Pause event writes and checkout briefly. Drain in-flight checkouts and wait
   until active holds and payments have settled or are represented by the
   Order reconciliation path.
4. Compare confirmed Order IDs with confirmed hold IDs. Confirm every
   `pending_payment` Order has an active or confirmed hold. Reconcile exceptions
   by stable order/hold ID before continuing.
5. Apply the reviewed Drizzle migrations with `MIGRATION_DATABASE_URL`. The
   Event ownership migration moves `events`, `inventory_holds`, and the Event
   outbox into `event_service`, removes the Identity foreign key, assigns the
   Event role, and revokes the compatibility API's write access. The inventory
   migration records confirmed orders without a confirmed hold as baseline sold
   capacity and recalculates occupied capacity from active/confirmed holds.
   The migration fails on a capacity constraint violation; resolve the drift
   and restore the snapshot before retrying if needed.
6. Check each event's `reserved_quantity` equals its baseline sold quantity
   plus active and confirmed hold quantities, and that it does not exceed
   `max_people`. Verify `ticketlive_public_api` has no Event table writes and
   `ticketlive_event` can read and write the Event schema.

## Switch traffic

1. Start Event service with only the Event-owned database URL and point
   `EVENT_SERVICE_URL` and `INVENTORY_SERVICE_URL` at it.
2. Verify Event `/health/ready`, internal hold create/get/confirm/release, and
   public API `GET /events`, `POST /events`, and `GET /events/search` through the
   authenticated gateway. Direct Event calls must present the internal bearer
   token; an actor header alone is rejected.
3. Start the Event outbox relay and hold-expiry sweep. Start the Order worker
   and verify its hold calls reach Event. Run `pnpm event:rebuild-index` once
   after the route switch if the existing Elasticsearch index may contain stale
   documents, passing the Event database URL only to the rebuild process:

   ```sh
   EVENT_SERVICE_DATABASE_URL='postgres://ticketlive_event:<password>@localhost:5433/ticket_live' pnpm event:rebuild-index
   ```
4. Verify `/chat/events/stream` returns cards from Event and that Order's
   runtime has no Event database URL. Keep the old routing available only as a
   controlled rollback path.

## Acceptance record

Record test event IDs, Order IDs, hold IDs, outbox IDs, and before/after
capacity values for these checks:

| Scenario | Required result |
| --- | --- |
| Parallel holds for the final tickets | Occupied capacity never exceeds `max_people`. |
| Repeated hold confirm, release, and expiry | Terminal transitions do not change capacity twice. |
| Event cancellation | New holds return 404; existing holds can still be confirmed, released, or expire under the approved policy. |
| Search index rebuild | Search returns current non-deleted catalog data after rebuilding from Event's database. |
| Chat hydration | Cancelled, deleted, and past events are omitted from fresh cards. |
| Order and Event drift check | Order emits an alert with stable IDs for a missing or mismatched hold; no cross-schema runtime join is used. |
| Credential isolation | Order calls Event over HTTP and has no Event database URL. |

## Rollback

Stop new Event writes and checkout traffic before changing routing. Preserve the
post-cutover Event and Order data. Restore old routing only after reconciling
all post-cutover event, hold, order, and outbox changes by their stable IDs;
switching the URL alone would split ownership and capacity state. Restore the
database snapshot only when the incident owner accepts losing writes made since
that snapshot.
