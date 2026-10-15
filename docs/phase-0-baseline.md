# Phase 0 baseline

This records the current public behavior and data seams before the Order service is extracted. It does not move business code or change the checkout workflow.

## Workspace and code ownership

The repository is a pnpm workspace. The current application remains at the repository root so its launch path and deployment stay stable during Phase 0. `apps/public-api` is a launch alias for the current app; the four service workspaces are reserved for incremental moves in their planned order. `packages/contracts` contains wire schemas only. Database schemas, Drizzle models, and business logic stay with their owning application.

The active app imports the checkout and message schemas from `@ticket-live/contracts`. The OpenAPI and AsyncAPI files under `docs/contracts/` record the HTTP and message examples, owners, errors, and compatibility rules.

## Database identities and future schemas

The local PostgreSQL bootstrap creates these schema owners and sets each login's default `search_path` to its own schema:

| Schema | Login | Future owner |
| --- | --- | --- |
| `identity_service` | `ticketlive_identity` | Remaining Identity/auth application |
| `order_service` | `ticketlive_order` | Order service |
| `event_service` | `ticketlive_event` | Event service |
| `email_service` | `ticketlive_email` | Email service |
| `notification_service` | `ticketlive_notification` | Notification service |

Set the `TICKETLIVE_*_DB_PASSWORD` values in `.env` before using these logins. The example values are local development credentials only. The bootstrap starts service schemas empty; after the Phase 1.1 storage migration, `order_service` contains Order's tables. The remaining service schemas still have no access to the existing tables in `public`.

The temporary `ticketlive_public_api` login is a compatibility credential, not a service ownership boundary. It cannot create schemas or own tables. After Phase 1.1 it can access both the legacy `public` tables and Order's tables in `order_service` so the still-integrated app can run.

The current app uses the dedicated `ticketlive_public_api` compatibility login through `DATABASE_URL`. Checkout still updates Event capacity and Order records within the same application transaction, across `public` and `order_service`. `MIGRATION_DATABASE_URL` remains a separate migration/admin credential. The API process and Event inventory boundary will be separated in later Phase 1 work.

## Data ownership and write inventory

| Current table/data | Current writes | Future owner |
| --- | --- | --- |
| `users` | `registerService.ts` inserts a user | Identity / remaining app |
| `revoked_access_tokens` | `logoutService.ts` inserts a token revocation | Identity / remaining app |
| `events` | `eventsService.ts` inserts events; `checkoutService.ts` increments `reserved_quantity`; `expireReservationsService.ts` and checkout failure decrement it | Event service |
| `orders` | `checkoutService.ts` inserts, confirms, or cancels orders; `expireReservationsService.ts` marks pending orders expired | Order service |
| `payments` | `checkoutService.ts` inserts, succeeds, or fails payments; `expireReservationsService.ts` cancels pending payments | Order service during this migration |
| `outbox_events` | Event creation and checkout insert rows; `outboxWorker.ts` updates `processed_at`, `attempts`, and `last_error` | Local outbox per owning service: Event or Order |
| `email_deliveries` | `emailWorker.ts` inserts a simulated delivery, ignoring duplicate event IDs | Email service |

The relevant write entry points are already named modules: `createEvent`, `checkout` and its transaction helpers, `expirePendingReservations`, `processOutboxBatch`, and `recordSimulatedDelivery`. The transaction in `checkout` is intentionally still cross-table in this phase.

## Public behavior recorded

`POST /orders/checkout` requires an access token and a JSON body with `eventId` (UUID) and `quantity` (integer 1–10,000). It returns `201` with `{ event, order, payment }` only after the mock payment succeeds and the order is confirmed. The order contains its price and currency snapshot, `status: "confirmed"`, and `expiresAt: null`; payment contains its ID, `status: "succeeded"`, and `gateway: "mock"`.

Invalid input returns `400`; missing, deleted, or cancelled events return `404`; exhausted capacity, a declined mock payment, or an expired reservation returns `409`. The current handler does not implement `Idempotency-Key`. The full request/response contract is in `docs/contracts/openapi.yaml`.

`GET /events` reads non-deleted rows from PostgreSQL. `GET /events/search` requires authentication and searches Elasticsearch by relevance then event start time; its index is eventually consistent and the endpoint returns indexed documents without refreshing them from PostgreSQL. Event chat searches the same index, then rechecks candidate IDs against PostgreSQL and preserves their search rank.

Checkout creates a pending reservation with the configured TTL (default 900 seconds), then calls the mock payment adapter outside the reservation transaction. On success the current request confirms the order and returns; on payment failure it cancels the order, releases capacity, marks the payment failed, and returns `409`. `expirePendingReservations` can expire pending orders and release capacity atomically, but no periodic scheduler currently calls it. Add and observe that worker as part of the relevant migration work; Phase 0 does not alter this behavior.

## Message ownership and compatibility

Order owns `order.confirmed.v1`; it contains the stable outbox event ID, aggregate/order ID, event time, correlation ID, and the existing receipt snapshot. The current producer publishes to the existing durable RabbitMQ queue `booking-confirmation-email` with `messageId`, `correlationId`, `traceparent`, and optional `tracestate` headers. Email owns consumption and currently records a simulated delivery keyed by the event ID.

Notification will own creation of `email.send.v1`; Email will own delivery. That command schema is documented, but the Phase 0 app does not publish or consume it. Version 1 permits additive optional fields. Breaking changes require a new version and an overlap period where consumers support both versions. The current Email worker accepts already-queued legacy messages that have no `schemaVersion`; malformed and unknown versions are rejected and acknowledged to the broker's dead-letter/discard behavior rather than retried forever. Message payloads and examples are under `docs/contracts/`.

## Correlation, health, and metrics

HTTP requests accept a UUID `x-correlation-id`; otherwise the API creates one and returns it in the response header. The API validates W3C `traceparent`, creates a child span context, and passes trace context through the order outbox and RabbitMQ headers. Structured logs use JSON and include a service name plus available correlation, trace, order, event, and message IDs. Email addresses and message bodies are not written to logs.

`GET /health/live` checks that the process is running. `GET /health/ready` checks PostgreSQL and Elasticsearch. `GET /metrics` exposes HTTP request counts/latencies and pending outbox count/age in Prometheus exposition format. If `OTEL_EXPORTER_OTLP_ENDPOINT` is configured, request and worker spans plus cumulative request/outbox metrics are sent as OTLP/HTTP JSON to `/v1/traces` and `/v1/metrics`.

Prometheus scrape configuration, current alerts, and an importable Grafana dashboard are in `ops/prometheus/` and `ops/grafana/`. RabbitMQ dead-letter, Kafka lag, hold-age, and payment/hold mismatch signals do not exist yet and must be added when those data paths are introduced; Kafka remains out of scope until Phase 4. Prometheus rule names for those later signals are reserved in `ops/prometheus/alerts.yml` so each extraction can implement the matching metric without changing alert contracts.

## Proposed operational targets

These are starting proposals for the service owners to ratify before a traffic cutover, not measured production SLOs:

| Signal | Proposed target / alert threshold |
| --- | --- |
| Checkout server error rate | Below 0.5% over 30 days; alert above 1% for 10 minutes (exclude expected 4xx capacity/business outcomes) |
| Checkout latency | p95 below 3 seconds for the current synchronous mock path |
| Hold creation latency | p95 below 250 ms after the Event-owned hold interface exists |
| Outbox publication | p95 below 10 seconds; alert when the oldest pending row exceeds 60 seconds |
| RabbitMQ queue age | Below 30 seconds; alert on any dead-letter growth after a DLQ is configured |
| Kafka consumer lag | Below 1,000 messages and below 5 minutes after Kafka is introduced |
| Email delivery | p95 below 5 minutes after provider delivery status exists |

Do not cut traffic based on these targets until the accountable service owners agree to the values and the later-phase hold, queue, consumer, and delivery metrics are live.

## Phase 1.1 — Order boundary and storage

The first Order storage step moves `orders` and `payments` into the private
`order_service` schema, removes Order's foreign keys to Event and Identity, and
copies the event/customer receipt details onto each order. Existing orders are
backfilled from their current event and user rows during migration; new orders
capture those details at checkout. Order confirmations now use
`order_service.outbox_events`; existing `order.confirmed` rows are copied there
with their IDs and delivery state, while `event.created` rows stay in the
remaining app's `public.outbox_events` table.

`order_service.checkout_attempts` stores a per-user idempotency key, a hash of
the checkout body, the order ID, and the final HTTP result. A repeat with the
same key and body replays that result. The same key with different checkout
details returns `409`; a concurrent repeat while the first request is still
running also returns `409` and can be retried with the same key. The checkout
endpoint now requires `Idempotency-Key`.

This storage step does not extract an independent Order process yet. The current
API still uses its compatibility database login and still performs the existing
Event capacity update; the Event-owned inventory interface and Order checkout
state machine are later steps in Phase 1.
