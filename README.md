# Ticket Live Server

Ticket Live is a Node.js API for an event ticket booking app. Users can register
and sign in, create and search events, and check out tickets. Event owns the
catalog and inventory in PostgreSQL, Order owns orders, Payment owns payment
records and the provider boundary, and Event uses Elasticsearch for search.
Checkout uses a mock payment provider. After an order is confirmed, the Order
outbox publishes to Email and Ticketing through RabbitMQ. Email currently
records simulated confirmation delivery, while Ticketing creates one ticket
record per item.

## Local services

Requirements: Docker with the Compose plugin, pnpm 11, and Node.js 24 or newer.
Run these commands from the repository root. The root `.env` file is shared by
all host-started services and is also read by Docker Compose. It is ignored by
Git; keep your local secrets there and never commit it.

1. Create `.env` and set local database passwords, broker passwords, and
   service tokens from the example:

   ```sh
   cp .env.example .env
   ```

   For local development, the example values are suitable. In particular,
   `PUBLIC_API_EVENT_TOKEN` is one shared secret: the Public API reads it to
   authenticate calls to Event, and Event reads the same value to verify them.
   Keep one matching entry in the root `.env`; do not put it in frontend code
   or create separate service-specific `.env` files. The browser calls the
   Public API at `http://localhost:4002`; that service calls Event at
   `http://localhost:4003` using this token. For a non-local environment,
   replace all example credentials with unique generated secrets. For example:

   ```sh
   openssl rand -hex 32
   ```

   Copy the generated value into the matching setting in `.env`. The
   Public API and Event need the same `PUBLIC_API_EVENT_TOKEN`. Order and Event
   also need the same `ORDER_EVENT_TOKEN` for inventory requests. These are
   separate credentials: setting one does not configure the other. The other
   service relationships use their matching token settings in `.env` as well.
   Public API and Ticketing share `PUBLIC_API_TICKETING_TOKEN`; scanner clients
   use the separate `TICKETING_CHECK_IN_TOKEN`.
   Order and Payment share `ORDER_PAYMENT_TOKEN` for the private payment API.

2. Start the infrastructure services:

   ```sh
   docker compose up -d postgres elasticsearch rabbitmq
   ```

   PostgreSQL is available at `localhost:5433`, Elasticsearch at
   `http://localhost:9200`, and RabbitMQ at `localhost:5672`. RabbitMQ's
   management dashboard is at `http://localhost:15672`; the credentials come
   from `RABBITMQ_ADMIN_USER` and `RABBITMQ_ADMIN_PASSWORD` in `.env`.

3. Create the local service database roles and RabbitMQ users:

   ```sh
   docker compose --profile bootstrap run --rm db-role-bootstrap
   docker compose --profile bootstrap run --rm rabbitmq-role-bootstrap
   ```

   The repeatable PostgreSQL bootstrap grants the public API access to identity
   records and revokes its former access to `order_service`. Each service gets
   its own database login. The RabbitMQ bootstrap creates separate local Order,
   Event, Email, and Ticketing principals; production credentials and ACLs are
   managed outside Compose.

4. Apply the checked-in Drizzle migrations before starting the applications:

   ```sh
   docker compose --profile tooling run --rm migrations
   ```

   The Compose migration job uses the PostgreSQL admin credentials from `.env`
   and connects on the Compose network. The Compose application profile never
   applies migrations automatically. To run migrations from the host instead,
   install dependencies with `pnpm install` and run
   `pnpm exec drizzle-kit migrate` using `MIGRATION_DATABASE_URL`.

5. Build and start all seven applications:

   ```sh
   docker compose --profile apps up -d --build
   ```

   The public API listens at `http://localhost:4002`, Event at `:4003`, Email
   at `:4004`, Order at `:4005`, Payment at `:4006`, Ticketing at `:4007`, and
   Analytics at `:4008`. Ticketing issues one ticket record per confirmed order
   item, exposes authenticated
   `GET /tickets`, and supports internal check-in by ticket ID. QR tokens and QR
   images are intentionally excluded. Analytics remains a health/metrics
   skeleton.
   The API checks user identity and passes a
   minimized customer snapshot to Order over the private service interface.
   Order owns checkout orchestration, order state, reconciliation, and its
   transactional outbox. Payment owns payment records and provider calls. Keep
   one Order service instance active until outbox row claims are
   implemented for multi-instance operation.

### Run the services from your host

Use this option when running the Node.js services with `pnpm` instead of the
Compose `apps` profile. Complete steps 1–4 above first: the database, service
roles, RabbitMQ users, and migrations are still required. Then install the
workspace dependencies:

```sh
pnpm install
```

Start each command in its own terminal from the repository root:

```sh
pnpm start:event-service
pnpm start:email-service
pnpm start:order-service
pnpm start:payment-service
pnpm start:ticketing-service
pnpm start:analytics-service
pnpm start
```

These commands load the root `.env`. Start Ticketing before Event and Order;
start Event and Payment before Order, then start Order and Event before the
Public API. Email is needed for confirmation delivery. Order, Event, and
Ticketing run their background work with the service process. The host ports are `4002` (Public API), `4003`
(Event), `4004` (Email), `4005` (Order), `4006` (Payment), `4007` (Ticketing),
and `4008` (Analytics). For example, request the public
event catalog at `http://localhost:4002/events`; the Public API forwards that
request to Event over its internal authenticated endpoint. Check readiness at
`/health/ready` on each service port.

The authenticated `GET http://localhost:4002/tickets` endpoint returns ticket
records for the signed-in user's confirmed orders. The internal
`POST http://localhost:4007/internal/tickets/check-in` endpoint accepts
`ticketId` and `eventId` and requires `TICKETING_CHECK_IN_TOKEN`. Set
`TICKETS_PORTAL_URL` to the frontend's My Tickets route for the optional link in
confirmation email data. The local email provider only records simulated
delivery; it does not send the message.

If the database reports missing tables, run the migrations in step 4 before
starting the services. If an internal call reports that authentication is not
configured, confirm that the root `.env` has a valid `PUBLIC_API_EVENT_TOKEN`
and restart both the Public API and Event so they load the same value. If Order
logs an inventory authentication error during its maintenance pass, check that
`ORDER_EVENT_TOKEN` is set and matches the value Event uses, then restart both
Order and Event.

Choose either the Compose application command in step 5 or the host commands
above; do not start both versions at the same time because they use the same
ports.

The public API, Order, Event, and Email expose `/health/live`, `/health/ready`,
and `/metrics`. Prometheus scrapes those endpoints and RabbitMQ queue metrics
using [`ops/prometheus/prometheus.yml`](ops/prometheus/prometheus.yml). Configure
`OTEL_EXPORTER_OTLP_ENDPOINT` to send service traces and metrics to a collector.
The local fake Email provider records simulated provider acceptance; it does
not send real email or generate PDFs. Production Email startup remains disabled
until a real provider is configured.

The Phase 0 ownership, contract, and behavior baseline is in
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

Public API tests can be run separately. The fast HTTP suite needs no database;
the identity integration suite starts a disposable PostgreSQL container through
Testcontainers and requires Docker:

```sh
pnpm test:public-api
pnpm test:public-api:integration
```

Service-only endpoints under `/internal` use separate credentials for the
public API to Order, public API to Event, Order to Event, and Email's internal
lookup. Production startup rejects the shared development fallback. Do not
expose internal routes to browser clients. Active holds expire every two seconds by default;
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

After a checkout payment succeeds, Payment stores its record in
`payment_service.payments`. Order stores the returned payment ID and status
projection with the `order.confirmed` row in `order_service.outbox_events` in
one local PostgreSQL transaction. The API can then return
the confirmed order without waiting for RabbitMQ or background email handling.
Only the Order database login can read or write this schema; the public API
loads the customer name and email from its identity store and sends those
minimal fields with the authenticated checkout handoff.

Inspect pending outbox rows with:

```sh
docker compose exec postgres psql -U user -d ticket_live \
  -c "SELECT id, event_type, aggregate_id, payload, created_at FROM event_service.outbox_events WHERE processed_at IS NULL UNION ALL SELECT id, event_type, aggregate_id, payload, created_at FROM order_service.outbox_events WHERE processed_at IS NULL ORDER BY created_at;"
```

Rows remain pending until their owning service's relay processes them. Event
indexes catalog changes, while the Order service routes:

- `order.confirmed` is adapted to an `email.send.v1` RabbitMQ command for the
  email worker. The command has a stable notification key, persistent delivery,
  publisher confirms, and mandatory routing checks.
- `inventory.hold.release` is retried against Event by stable hold ID after an
  Order payment failure or reservation expiry.

The Event service processes `event_service.outbox_events`; the Order service
processes `order_service.outbox_events`. Each marks a row processed after its
destination accepts the event. Failed rows retain attempt counts and retry with
capped exponential backoff and jitter.

Order sends `order.confirmed.v1` to Ticketing as well as the email command.
Ticketing creates one record per quantity, with a stable order/ticket-number
uniqueness constraint for retries. Event sends `event.cancelled` and
`event.deleted` to Ticketing, which marks active tickets invalid and remembers
cancelled event IDs so late order messages cannot issue active tickets.
Refund and confirmed-order cancellation events are not available yet and are
deferred. To populate existing confirmed orders after rollout, first inspect
the replay with `pnpm replay:ticketing-orders`, then apply with
`pnpm replay:ticketing-orders -- --apply`. Existing Event cancellations can be
replayed similarly with `pnpm replay:ticketing-cancellations -- --apply`.

Checkout now requires an `Idempotency-Key` header. If a client retries the
same checkout body with the same key after the first request finishes, the API
returns the saved result instead of creating another order. A concurrent retry
while the first is still processing, or the same key with different checkout
details, gets `409 Conflict`.

Checkout creates one stable Order ID before requesting its Event hold. Order
persists the hold's event and price snapshots, then calls Payment using the
Order ID as the payment idempotency key. Payment stores the provider result;
Order records the returned payment ID and status before asking Event to confirm
the hold. Only a confirmed hold can produce
the `order.confirmed` outbox message. Payment failures and expired pending
orders persist `inventory.hold.release` commands in the Order outbox. The
Order service retries those commands and reconciles stale checkout attempts.
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

For deployment configuration, credential ownership, TLS, topology setup, and
rollback guidance, see [`docs/deployment.md`](docs/deployment.md). For
monitoring and the audited one-order replay procedure, see
[`docs/phase-4-cutover.md`](docs/phase-4-cutover.md). The local Prometheus
configuration scrapes all seven services, including Order outbox state, Event
hold age/conflicts/expiry, Email delivery outcomes, and RabbitMQ queue depth and
oldest-message timestamps. Ticketing and Analytics currently expose HTTP metrics
only. RabbitMQ's Prometheus endpoint is exposed on
`localhost:15692` for local monitoring.

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

Chat can filter by one explicitly named music genre from the controlled list
`blues`, `classical`, `country`, `electronic`, `folk`, `funk`, `hip-hop`,
`jazz`, `metal`, `pop`, `punk`, `reggae`, `rock`, and `soul`, plus the existing
free-text event location field. Events without a genre label are excluded from
a genre-specific search. If a request names multiple or excluded genres, chat
asks which single genre to use. The final event cards are checked against the
genre and location filters before they are sent. When the model supplies a
location, the server requires that text to appear in the customer's message,
then checks returned cards with a case-insensitive substring match. Location
is still free text, so this does not catch every location extraction error;
canonical city IDs are needed for that.

The event creation API and Event service update API accept an optional `genre`
field. Existing events remain unclassified until their labels are reviewed and
set. This field is a catalog label; it is not independently verified by an
automatic classifier.

The model evaluation dataset and runner live in
`apps/public-api/src/chat/evals/event-chat.json` and
`apps/public-api/src/chat/eventChatEval.ts`. The expected answers are read by
the runner after each model response; they are never sent to Gemini. Start
PostgreSQL and Elasticsearch and set `GEMINI_API_KEY` plus the Event service
token in `.env`. Apply migrations and rebuild the Event search index, then
start Event before running:

```sh
pnpm exec drizzle-kit migrate
pnpm event:rebuild-index
pnpm start:event-service
pnpm eval:event-chat
pnpm eval:event-chat -- --case jazz-in-berlin
```

The report measures the model's required intent fields, the final search
criteria, supported finish outcomes, and whether every returned card obeys
the expected genre and location. It fails with a non-zero exit code on a
mismatch. Add manually reviewed `expectedEventIds` for relevant events in the
first five results to measure retrieval precision and recall; the starter
dataset leaves these unlabelled because relevant event IDs depend on the
catalog. The `/metrics` endpoint also exports aggregate chat outcomes,
explicit-genre corrections, and cards discarded by the final filter. These
counters are process-local and reset when the Public API restarts.

The model does not answer FAQs or live ticket availability questions. Search
remains eventually consistent. Event hydrates search IDs from PostgreSQL to
exclude events that are no longer active; newly created or relabeled events
appear after the Event outbox indexes them.
