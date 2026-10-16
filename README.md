# Ticket Live Server

Ticket Live is a Node.js API for an event ticket booking app. Users can register
and sign in, create and search events, and check out tickets. Event owns the
catalog and inventory in PostgreSQL, Order owns orders, and Event uses
Elasticsearch for event search. Checkout uses a mock payment provider. After an order is confirmed, a background
worker publishes a message through RabbitMQ; the email worker currently records
a simulated confirmation delivery.

## Local services

Requirements: Docker with the Compose plugin, and pnpm.

1. Create your local environment file:

   ```sh
   cp .env.example .env
   ```

2. Start PostgreSQL, Elasticsearch, and RabbitMQ:

   ```sh
   docker compose up -d
   ```

   Run the one-time, repeatable database-role bootstrap after PostgreSQL is
   healthy:

   ```sh
   docker compose run --rm db-role-bootstrap
   ```

   This creates `identity_service`, `order_service`, `event_service`, and
   `email_service` schemas with separate local
   roles, and a temporary `ticketlive_public_api` runtime login for the current
   integrated app. The Order and Event storage migrations fill their schemas.
   Migrations use `MIGRATION_DATABASE_URL`;
   set the `TICKETLIVE_*_DB_PASSWORD` values in `.env` before using these
   logins. The public API compatibility login is intentionally able to access
   all legacy tables until the first ownership cutover.

   PostgreSQL is available at `localhost:5433`, Elasticsearch at
   `http://localhost:9200`, and RabbitMQ at `localhost:5672`. RabbitMQ's
   management dashboard is at `http://localhost:15672` (`guest` / `guest`).
   The services keep their data in named Docker volumes, so it survives
   container restarts.

3. Apply the checked-in Drizzle migrations:

   ```sh
   pnpm exec drizzle-kit migrate
   ```

4. Start Event service in a terminal, using the Event-owned database login:

   ```sh
   EVENT_SERVICE_DATABASE_URL=postgres://ticketlive_event:local-event-password@localhost:5433/ticket_live pnpm start:event-service
   ```

   It listens at `http://localhost:4003`, owns event catalog and inventory
   tables, expires holds, and indexes its transactional outbox. Keep this
   database URL only in the Event service process environment.

5. Start the public API server in another terminal:

   ```sh
   pnpm start
   ```

   The equivalent workspace entry point is
   `pnpm --filter @ticket-live/public-api start`.

6. Start the Order outbox worker:

   ```sh
   TICKETLIVE_SERVICE=order pnpm start:worker
   ```

   The API listens at `http://localhost:4002`. The worker has no HTTP port; set
   `ORDER_SERVICE_DATABASE_URL` to the `ticketlive_order` DSN in `.env`. It polls
   Order's PostgreSQL outbox and publishes email and inventory commands. Keep
   one Order outbox worker active until row claims are implemented for
   multi-worker operation.

7. Start the Email service with its own database login:

   ```sh
   EMAIL_SERVICE_DATABASE_URL=postgres://ticketlive_email:local-email-password@localhost:5433/ticket_live pnpm start:email-service
   ```

   It listens on `http://localhost:4004`, consumes the `email.send.v1` queue,
   and temporarily drains the legacy `booking-confirmation-email` queue while
   `EMAIL_LEGACY_QUEUE_ENABLED=true`. Delivery records live in `email_service`.
   Prometheus metrics are available at `http://localhost:4004/metrics`.
   The local fake provider records provider acceptance but does not send real
   email or generate PDFs.

The API exposes `GET /health/live`, `GET /health/ready`, and `GET /metrics`.
Configure `OTEL_EXPORTER_OTLP_ENDPOINT` to send OTLP traces and metrics to a
collector. The Phase 0 ownership, contract, and behavior baseline is in
[`docs/phase-0-baseline.md`](docs/phase-0-baseline.md); current API and message
schemas are in [`docs/contracts/`](docs/contracts/).
The Email service migration and queue drain procedure is in
[`docs/phase-3-cutover.md`](docs/phase-3-cutover.md).

## Quality checks

Run the repository checks with:

```sh
pnpm lint
pnpm typecheck
pnpm test
```

The service-only inventory endpoints under `/internal` use
`INTERNAL_SERVICE_TOKEN`. Set it in `.env` to a random value of at least 32
bytes (the `.env.example` value is a placeholder) and give it only to trusted
service callers; production startup requires it. The internal API is not for
browser clients. Active holds expire every two seconds by default;
`INVENTORY_HOLD_EXPIRY_POLL_INTERVAL_MS` adjusts that polling interval.
Order calls the Event inventory API at `INVENTORY_SERVICE_URL`, which defaults
to `http://localhost:4003`. Public catalog and chat requests use
`EVENT_SERVICE_URL`, also defaulting to port 4003.

To stop PostgreSQL while keeping its data, run `docker compose down`. To also
delete the local database volume and all its data, run
`docker compose down -v`.

## Local Elasticsearch

Elasticsearch runs as a single node and stores its data in the
`elasticsearch_data` Docker volume. Confirm that it is ready:

```sh
curl http://localhost:9200
```

The local service disables Elasticsearch security and binds port 9200 to
`127.0.0.1`, so it is accessible only from this machine. Production deployments
must enable authentication and TLS.

## Event outbox

Creating an event now inserts both the event row and an `event.created` row in
`event_service.outbox_events` within the same PostgreSQL transaction. The outbox row contains
the event ID and a JSON snapshot for indexing. If either insert fails,
PostgreSQL rolls back both inserts.

After a checkout payment succeeds, the order, payment, and `order.confirmed`
row in `order_service.outbox_events` are committed in one PostgreSQL
transaction. The API can then return
the confirmed order without waiting for RabbitMQ or background email handling.

Inspect pending outbox rows with:

```sh
docker compose exec postgres psql -U user -d ticket_live \
  -c "SELECT id, event_type, aggregate_id, payload, created_at FROM event_service.outbox_events WHERE processed_at IS NULL UNION ALL SELECT id, event_type, aggregate_id, payload, created_at FROM order_service.outbox_events WHERE processed_at IS NULL ORDER BY created_at;"
```

Rows remain pending until their owning service's relay processes them. The Event
service indexes catalog changes, while the Order worker routes:

- `order.confirmed` is adapted to an `email.send.v1` RabbitMQ command for the
  email worker. The command has a stable notification key, persistent delivery,
  publisher confirms, and mandatory routing checks.
- `inventory.hold.release` is retried against Event by stable hold ID after an
  Order payment failure or reservation expiry.

The Event service processes `event_service.outbox_events`; the Order worker
processes `order_service.outbox_events`. Each marks a row processed after its
destination accepts the event. Failed rows retain attempt counts and retry with
capped exponential backoff and jitter.

Checkout now requires an `Idempotency-Key` header. If a client retries the
same checkout body with the same key after the first request finishes, the API
returns the saved result instead of creating another order. A concurrent retry
while the first is still processing, or the same key with different checkout
details, gets `409 Conflict`.

Checkout creates one stable Order ID before requesting its Event hold. Order
persists the hold's event and price snapshots, then calls the mock payment
adapter outside the database transaction. A successful payment is recorded
before Order asks Event to confirm the hold; only a confirmed hold can produce
the `order.confirmed` outbox message. Payment failures and expired pending
orders persist `inventory.hold.release` commands in the Order outbox. The
outbox worker retries those commands and reconciles stale checkout attempts.
If a checkout returns `503` while Event is unavailable or the outcome is
uncertain, retry with the same key so reconciliation can continue safely.

The Event service creates an Elasticsearch `events` index on first use and
applies catalog changes with monotonically increasing versions. Rebuild the
index from Event's database with
`EVENT_SERVICE_DATABASE_URL=postgres://ticketlive_event:local-event-password@localhost:5433/ticket_live pnpm event:rebuild-index`.

The Email service validates each `email.send.v1` command, stores a unique
delivery intent by `notificationKey`, and acknowledges the RabbitMQ message only
after the outcome is durably recorded or safely routed for retry. The local fake
provider records `accepted_by_provider`; that does not mean an email reached an
inbox. Legacy `simulated` records remain available in the `email_service`
schema. Delayed retries use `email.send.v1.retry`; poison and exhausted messages
go to `email.send.v1.dlq`. Inspect delivery records with:

```sh
docker compose exec postgres psql -U user -d ticket_live \
  -c "SELECT notification_key, order_id, status, provider_name, provider_message_id, attempts, created_at FROM email_service.email_deliveries ORDER BY created_at DESC;"
```

The delivery lookup is service-authenticated at
`GET http://localhost:4004/internal/deliveries/{notificationKey}`. A real
provider adapter is intentionally not enabled until provider credentials,
verified sender/domain, webhook handling, and delivery policy are ready.

The RabbitMQ test publisher and consumer under `src/scripts/` are development
helpers. The test consumer reads from the same queue as the email worker, so do
not leave it running while processing real confirmation messages.

For monitoring and the audited one-order replay procedure, see
[`docs/phase-4-cutover.md`](docs/phase-4-cutover.md). The local Prometheus
configuration scrapes Order outbox metrics, Email delivery outcomes, and
RabbitMQ queue depth and oldest-message timestamps. RabbitMQ's Prometheus
endpoint is exposed on `localhost:15692` for local monitoring.

## Event search

`GET /events/search` asks Event to query Elasticsearch and refreshes its results
from Event's catalog. It requires
the same access token as other event routes and supports a required `q` query
parameter plus an optional `limit` from 1 to 50:

```text
GET /events/search?q=berlin%20music&limit=20
```

The search checks event names, descriptions, and locations. Name matches rank
highest, cancelled events are excluded, and Elasticsearch returns the remaining
results by relevance and then by event start time.

## Event discovery chat

The authenticated `POST /chat/events/stream` endpoint accepts a natural-language
event search and streams Server-Sent Events (SSE) over the same HTTP response.
It uses LangGraph to extract supported search criteria, asks Event for ranked
search candidates and fresh event cards, then streams a short introduction
from the configured Gemini model. Event cards arrive in a `results` frame before
the model introduction, so the frontend can render them immediately.

Configure the server-side provider key in `.env` before calling the endpoint:

```env
GEMINI_API_KEY=your-server-side-key
EVENT_CHAT_MODEL=gemini-3.8-flash
```

Example request:

```http
POST /chat/events/stream
Authorization: Bearer <access-token>
Content-Type: application/json
Accept: text/event-stream

{"message":"Jazz events in Berlin","limit":5}
```

The stream emits `status`, then `results` (`events` plus `count`), one or more
`delta` events for the introduction, and a terminal `done` event. Errors after
the stream starts use an `error` event; validation and configuration errors
before it starts use JSON responses. A `provider_quota_exhausted` error means
the configured Gemini project has exhausted its provider quota; wait for its
reset or increase the project's Gemini quota. Frontends should use `fetch()`
and parse the response body incrementally, since this endpoint uses POST with
a JSON body and bearer token.

Chat search only supports text and the existing free-text event location field.
It does not answer FAQ or live availability questions, and the index remains
eventually consistent. Event hydrates search IDs from its database to exclude
events that are no longer active; newly created events appear after the Event
outbox indexes them.
