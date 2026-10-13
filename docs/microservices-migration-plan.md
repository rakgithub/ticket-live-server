# Ticket Live: phased migration to four microservices

Status: implementation plan, 13 October 2026. No migration is implemented by this document.

## 1. Outcome and decisions

Extract services in the requested order: **Order**, **Event**, **Email**, **Notification**. Keep them in one monorepo with separate processes, images, deployments, credentials, migrations, and data ownership. Maintain the existing public API during migration; the current Express app can forward routes until a dedicated gateway has a practical purpose. Migrate one business capability at a time and switch off its old writer before enabling its new writer. This is an incremental migration following the [strangler fig approach](https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-decomposing-monoliths/strangler-fig.html).

Target responsibilities:

| Component | Owns | Does not own |
| --- | --- | --- |
| Order service | Checkout endpoint, order state, checkout orchestration, price snapshot, temporary mock payment adapter, order outbox | Event capacity, event catalog, email delivery |
| Event service | Event catalog, ticket capacity, holds/reservations, availability, event search/indexing | Orders, payment attempts, message delivery |
| Email service | Email templates, provider adapter, delivery attempts/status, email job queue | Deciding which business event warrants an email |
| Notification service | Notification rules, channel preferences, intent records, routing, notification status | Sending email through the provider or changing orders |
| Remaining application | Identity/auth and event discovery chat initially; public façade during migration | Tables moved to extracted services |

**Email versus Notification:** Email is a channel delivery service. Notification decides whether an `order.confirmed` event calls for an email, which template to use, and whether the recipient opted out where applicable. When Notification is introduced, it will create `email.send` commands for Email. Before that, Order may create confirmation email jobs directly as a temporary adapter. These are separate services only if multiple channels/rules are genuinely planned; otherwise merge them and omit Phase 4's service split.

**Payment scope:** The repository currently uses a mock charge inside checkout. Keep that adapter in Order during this migration so a fifth service does not obscure the four requested phases. Before real charges, implement provider idempotency, webhook verification, reconciliation, refunds, and the late-success path. Extract Payment later if its security, ownership, or release needs justify it. Do not claim this four-service design is production payment-ready while using the mock.

**Messaging choice:** Kafka holds versioned business facts such as `order.confirmed` for independently progressing consumers and bounded replay. RabbitMQ carries actionable `email.send` jobs with acknowledgement, retry, and dead-letter handling. Multiple consumers alone do not require Kafka; this plan introduces Kafka when Notification and future analytics need a retained event stream. The first two phases do not need a second broker. Kafka is not the source of truth for orders or inventory; PostgreSQL is. RabbitMQ is not an event archive. Kafka retention is finite unless explicitly configured otherwise. See [Kafka's log design](https://kafka.apache.org/40/design/design/) and [RabbitMQ reliability guidance](https://www.rabbitmq.com/docs/reliability).

## 2. Current implementation and the seams to cut

The current checkout in `src/services/orders/checkoutService.ts` atomically increments `events.reserved_quantity`, inserts `orders` and `payments`, then calls `MockPaymentProvider`. It confirms the order/payment and inserts `order.confirmed` in `outbox_events`. `expirePendingReservations` updates orders, event capacity, and payments together. Those cross-table transactions cease to be possible once Order and Event have private databases. Therefore Phase 1 must first expose a sole inventory-owner interface in the existing app, then replace the transaction with a checkout state machine and compensations. A simple file move would be incorrect.

The outbox worker currently handles `event.created` by indexing Elasticsearch and `order.confirmed` by publishing to RabbitMQ's single `booking-confirmation-email` queue. The email worker only stores a simulated delivery row; it does not call an email provider. Event search and chat currently query both Elasticsearch and PostgreSQL event rows. Users and token revocations belong to the remaining app for now. See `src/services/events/eventsService.ts`, `src/services/events/eventsSearchService.ts`, `src/workers/outboxWorker.ts`, and `src/workers/emailWorker.ts`.

Before coding, record the existing public response for `POST /orders/checkout`: today it returns a confirmed order after the mock charge. With an asynchronous payment workflow, it may return `202 Accepted` and a pending order. That is a client-facing contract change; either preserve synchronous mock behavior during the first cutover or version the API and update clients together. Never silently change this behavior.

## 3. Target request and event flow

```text
Client -> current public API/future gateway -> Order service: POST /orders/checkout
Order -> Event service: create hold using stable order ID
Event service -> Order: hold ID, unit price, currency, expiry
Order: persist order + price snapshot; run mock payment adapter
Order -> Event service: confirm hold, or release it on failure
Order: persist final status + outbox record in one local transaction
Order outbox -> Kafka: order.confirmed.v1 (once Phase 4 is live)
Notification Kafka consumer -> notification intent + outbox
Notification outbox -> RabbitMQ: email.send.v1
Email worker -> provider; persist delivery result
```

Phase 1-3 transition: Order's outbox publishes the confirmation email job straight to RabbitMQ. Phase 4 moves the decision and job creation to Notification, and disables the direct route. Never run both routes for the same order without a shared, enforced idempotency key.

The Event service owns both event metadata and capacity. A hold **reserves** capacity, confirmation converts it into sold capacity, and release/expiry returns it. A confirmed order must not be issued until the hold is confirmed. If payment succeeds but hold confirmation or order persistence fails, mark the checkout `reconciliation_required`, keep the hold from expiring automatically until resolved, and alert an operator; for a real provider, refund/void as appropriate. Do not report success to the client while these facts disagree.

## 4. Phase 0 — foundations and migration safety

Implement only the infrastructure and contract work needed for the first extraction.

1. Create monorepo workspaces such as `apps/public-api`, `apps/order-service`, `apps/event-service`, `apps/email-service`, `apps/notification-service`, and `packages/contracts`. Move code incrementally; existing routes continue to run. Keep shared packages limited to contracts, tracing, and common utilities. Do not put shared Drizzle models or business logic in `packages/`.
2. Define service-private PostgreSQL schemas or databases and credentials. Separate schemas on one PostgreSQL server are adequate initially if credentials enforce access. Each service owns its migrations and grants; no cross-service foreign keys, joins, or writes after extraction. Business IDs remain UUIDs and are referenced as values across services. This follows the [database-per-service pattern](https://microservices.io/patterns/data/database-per-service.html).
3. Define versioned HTTP and message contracts in `packages/contracts`: schema, example, owner, compatibility policy, and error cases. Use OpenAPI for synchronous endpoints and AsyncAPI or equivalent documented schemas for messages. Validate at producer and consumer boundaries. Avoid sharing runtime ORM types as wire contracts.
4. Add correlation IDs and W3C trace context to HTTP and message headers; structured logs include `orderId`, `eventId`, `holdId`, `messageId`, and service name, excluding secrets and unnecessary customer data. Add health/readiness endpoints and OpenTelemetry traces/metrics. [OpenTelemetry signals](https://opentelemetry.io/docs/concepts/signals/) cover these observability types.
5. Agree on operational targets before migration: checkout success/error rate, maximum hold latency, outbox delay, queue age, consumer lag, and delivery delay. Add dashboards and alerts for stuck holds, unpublished outbox rows, RabbitMQ dead letters, Kafka lag, and payment/hold mismatches.
6. Inventory all current writes to `orders`, `payments`, `events.reserved_quantity`, `outbox_events`, and `email_deliveries`; make each write go through a named module interface before moving it. Document the current checkout response and expiry behavior. Add contract and failure-path checks before switching traffic.

Exit gate: a local environment can run the current app with service-specific credentials; public API and event search behavior are recorded; order creation, expiry, and email paths have observable IDs; each table has a documented future owner.

## 5. Phase 1 — extract Order service first

### 5.1 Boundary and storage

Order owns `orders`, a checkout state/attempt table, its local `outbox_events`, and an `inbox_messages` table if it consumes asynchronous results later. Keep `payments` and the mock adapter local for now. Update the order-status database check constraint to include the new intermediate and `reconciliation_required` states before the new code writes them. Store `eventId` and `userId` as UUID values without foreign keys into Event or Identity. Snapshot event title, start time, unit price, currency, quantity, and customer contact needed for receipts on the order at checkout time. Do not copy passwords or full user profiles. Introduce a client `Idempotency-Key` on checkout with a unique `(userId, key)` constraint and persist the request hash and response/order ID; reuse returns the original result, a different request with the same key is rejected.

### 5.2 Temporary Event-owned inventory interface

Before Order becomes the sole order writer, add private endpoints or an internal module façade to the **remaining app**, which still owns `events`: `POST /internal/events/{eventId}/holds`, `POST /internal/holds/{holdId}/confirm`, `POST /internal/holds/{holdId}/release`, and `GET /internal/holds/{holdId}`. These endpoints later move unchanged to Event service in Phase 2. Authenticate service callers; use deadlines, small bounded retries for transient failures, and stable idempotency keys. Do not expose them to browsers.

Create an `inventory_holds` table beside `events`, with `hold_id`, `order_id` (unique), `event_id`, quantity, unit price, currency, state (`active|confirmed|released|expired`), expiry, and timestamps. Under one PostgreSQL transaction, atomically check active event and available capacity, increment held capacity, and insert the hold. Preserve the current capacity invariant by defining `reserved_quantity` as **active holds plus confirmed sold units** during migration, or explicitly split into `held_quantity` and `sold_quantity` with a checked migration. Confirmation must keep total occupied capacity unchanged; release/expiry decrements only an active hold. Repeated `confirm`/`release` calls must be safe. Return `409` for exhausted stock and preserve `404` for unavailable events.

For host/organizer cancellation, choose and document a policy for active holds and confirmed orders before enabling new API behavior. A new hold must fail after cancellation. Keep event price and start-time snapshots on the hold; Order uses that exact snapshot, never an eventual search index value.

### 5.3 Checkout state machine

1. Public `POST /orders/checkout` routes to Order after auth. Order creates a stable order ID and uses it as the hold idempotency key. Request the hold first. If the reply is lost, query the hold by order ID before creating another one.
2. Persist a `pending_payment` order with hold ID, exact price snapshot, expiry, and checkout idempotency record. If that persistence fails after the hold exists, a reconciler releases orphan holds; the hold TTL is a final safety net.
3. Run the mock payment adapter outside a database transaction. Keep the existing synchronous response for this migration if feasible. For real payments, use a provider idempotency key and move to `202`/polling or a provider-confirmed flow before charging users. No network call may hold a database lock.
4. On mock failure, atomically transition Order to `cancelled` and record a pending release command in its outbox; call release promptly, then retry through the outbox/reconciler until confirmed. On mock success, request hold confirmation. Only after Event reports a confirmed hold may Order transition to `confirmed` and insert `order.confirmed` into its local outbox in the same transaction.
5. Resolve ambiguous responses by fetching the hold status. A timeout cannot be interpreted as success or failure. If hold confirmation succeeded but the Order write failed, retry the Order transition; do not release a confirmed hold. If payment succeeded but hold expired before confirmation, enter `reconciliation_required` and prevent normal confirmation; real-money implementations must refund or void.
6. Order expiry worker moves only its own pending orders to `expired` via guarded state transitions and requests hold release. Event independently expires active holds after TTL. Both sides reconcile by ID and terminal status; neither writes the other's tables.

Define legal transitions explicitly: `initiated -> held -> pending_payment -> confirmed`; branches to `cancelled`, `expired`, or `reconciliation_required`. Use conditional SQL updates (`WHERE status = ...`) plus unique constraints to prevent duplicate completion. Treat late mock/provider callbacks as a reconciliation case rather than reopening an expired order.

### 5.4 Outbox and temporary email path

Move the order outbox to Order's private schema. Before routing Order publishes, upgrade the legacy email worker to accept an `email.send.v1` command on a new queue and enforce a unique `notificationKey`; drain `booking-confirmation-email` with its original consumer during the switch. Order publishes the new command through a compatibility adapter until Notification exists. The job includes an immutable notification key such as `order-confirmation:{orderId}`, recipient, approved template ID, safe template data, and trace IDs. Use a durable queue and persistent messages. Use publisher confirms **and** `mandatory`/returned-message handling for exchange routing; a broker confirm alone can also acknowledge an unroutable publish. Mark an outbox row sent only after a positive confirm and successful routing. Keep the event/job IDs stable across retries. [RabbitMQ publisher confirms and returns](https://www.rabbitmq.com/docs/confirms).

The current outbox worker can duplicate a publish if it crashes after the broker confirms but before `processed_at` is written. At-least-once delivery plus consumer idempotency is the contract. If scaling the worker, claim rows with a lease or `FOR UPDATE SKIP LOCKED` inside short transactions, publish outside the lock, and record the claim outcome; otherwise keep one worker. Alert on old rows and cap retry rate with exponential backoff/jitter.

### 5.5 Cutover and acceptance

Backfill existing `orders` and `payments` with their original UUIDs and price snapshots. Reconcile counts and statuses, pause or drain checkout writes for the short ownership cutover, route new checkout requests to Order, and revoke the old app's write privilege on order tables. Keep the old path available only as a controlled rollback path; reversing ownership after new writes requires an explicit data reconciliation, not a toggle.

Acceptance checks: parallel final-ticket checkouts cannot oversell; duplicate HTTP requests create one order and one hold; timeout after hold creation is recovered; failure releases seats; payment success plus lost hold response reconciles; expiry during payment never confirms a dead hold; one order produces one logical confirmation intent despite outbox retries; public API behavior is versioned or preserved.

## 6. Phase 2 — extract Event service and inventory

1. Move the already established event catalog and hold API from the remaining app to Event service. Event owns `events`, `inventory_holds`, its outbox, and Elasticsearch index mappings. Order's hold client changes only its service address and authentication. Keep the hold API behavior and idempotency keys identical.
2. Backfill event and hold rows, including active holds and capacity counts. Reconcile `reserved_quantity` or `held + sold` against active and confirmed holds and legacy confirmed orders **before** switching writers. For historical orders without hold rows, create an explicit baseline sold count; do not silently free historical capacity. Snapshot and restore plan are required for cutover.
3. Route `GET /events`, `POST /events`, and `GET /events/search` to Event service through the current public API. Event service alone writes event rows. Keep Elasticsearch as a rebuildable read index fed by Event's transactional outbox (`event.created`, `event.updated`, `event.cancelled`, `event.deleted`). Index by event ID and version; rebuild from Event's database if the index is lost. Refresh candidate search hits from Event-owned data, as the current chat does, rather than reading the former shared table.
4. Migrate `/chat/events/stream` to call an Event search/read API for fresh cards. Remove its direct PostgreSQL and Elasticsearch clients once that API is verified. Give Event its own auth checks for direct/internal calls; do not trust a gateway header by itself.
5. Move the hold expiry worker and capacity reconciliation into Event. Order expiry only changes orders and requests release. Add a reconciliation job comparing pending orders with active/confirmed holds and alerting on drift, without direct DB joins in service runtime; an operational reconciliation tool may compare exported IDs/read APIs.
6. Switch reads first, then writes in a planned cutover. Revoke old app writes to `events` and `inventory_holds`; remove cross-service FKs and shared-table imports. Roll back by restoring routing only after reconciling post-cutover writes.

Acceptance checks: concurrent holds honor capacity, repeated confirm/release/expiry do not double-change it, event cancellation blocks new holds, event search/chat still return fresh valid data, Elasticsearch can be rebuilt, and Order has no Event database credentials.

## 7. Phase 3 — extract Email service

1. Move the already upgraded RabbitMQ consumer and `email_deliveries` into Email's private deployment and schema. Preserve the `email.send.v1` command and queue established in Phase 1. Confirm the old `booking-confirmation-email` queue is drained before removing its compatibility consumer. Keep the logical notification key unique in Email's database.
2. Implement a provider adapter interface with a fake provider in local development and a real transactional provider only when credentials, verified sender/domain, provider webhooks, and delivery policy are ready. Distinguish `queued`, `sending`, `accepted_by_provider`, `delivered`, `bounced`, and `failed`; provider acceptance is not proof of inbox delivery. Store provider message IDs and timestamps. Never log template secrets or full message bodies.
3. On consume, validate schema and version; insert or claim a unique delivery intent keyed by `notificationKey`, then send with a stable provider idempotency key where the provider supports it. Persist provider result and acknowledge after durable state is recorded. A provider timeout has an **unknown** outcome: query the provider by idempotency key/message ID or reconcile via webhook before retrying, because retrying blindly can send two emails. Record that true exactly-once external email delivery cannot be guaranteed by the broker alone.
4. Use a bounded retry policy for transient provider errors, delayed retry queues or quorum queue delivery limits, and a dead-letter queue for poison messages/exhausted retries. Do not immediately requeue forever. Alert on DLQ depth and age; document operator inspection and replay after a fix. RabbitMQ's [quorum queue](https://www.rabbitmq.com/docs/quorum-queues) and [acknowledgement](https://www.rabbitmq.com/docs/confirms) guidance informs this setup.
5. Expose internal `GET /deliveries/{notificationKey}` and provider webhook endpoints as needed. Authenticate webhooks and service calls. Emit a delivery status event only if another component needs it; Phase 4 Notification will consume it.

Acceptance checks: duplicate jobs create one logical delivery; an email outage does not hold checkout open; provider 429/5xx back off; malformed jobs reach DLQ; worker crash before ack reprocesses safely; provider callback updates status; old simulated records remain queryable or are migrated with preserved IDs.

## 8. Phase 4 — extract Notification service and introduce Kafka

### 8.1 Why Kafka starts here

Notification is the first independently evolving consumer of Order's *business fact* `order.confirmed`; analytics, fraud, or reporting may later use the same retained record. Add Kafka here for consumer independence and bounded replay. Do not route every job through Kafka. Keep `email.send` on RabbitMQ, where job acknowledgment and delivery retries belong. This division is an architectural choice for this project, not a rule that all companies need both brokers.

Create a `ticketlive.orders.v1` topic keyed by `orderId` for per-order ordering, with a documented retention period sized for the intended replay window and storage budget (propose 30 days initially, review against recovery requirements). Configure replication, `acks=all`, minimum in-sync replicas, an idempotent producer, authentication/TLS, and explicit ACLs in production. Local development can use a single node with a documented lower durability level. Do not confuse Kafka producer idempotence with exactly-once effects in PostgreSQL or an email provider. [Kafka producer configuration](https://kafka.apache.org/41/configuration/producer-configs/).

### 8.2 Publish and consume

1. Extend Order's outbox relay with a Kafka destination. For each final order transition, persist the business row and `order.confirmed.v1` outbox row atomically. Publish using the stable event ID as the payload ID, `orderId` as partition key, `occurredAt`, `schemaVersion`, `correlationId`, and minimal customer data. For privacy, prefer a recipient reference/approved contact snapshot in the Notification service or tightly controlled encrypted fields; set retention and deletion rules explicitly. Keep compatibility with the temporary RabbitMQ job while cutting over, but prevent both from causing separate sends.
2. Notification consumes `ticketlive.orders.v1` in its own consumer group. Validate event versions; insert `(consumerName, eventId)` into an inbox table and create a unique notification intent `(orderId, channel, purpose)` in **one local transaction**. Store the Kafka offset only after the transaction commits. If it crashes before committing the offset, replay finds the inbox record and performs no duplicate work. An unknown schema version is quarantined and alerted, not silently skipped.
3. Notification evaluates rules and preferences for `order.confirmed`. Persist an `email.send.v1` command in its own outbox, then relay it to RabbitMQ with publisher confirms and routing checks. The command carries `notificationKey=order-confirmation:{orderId}`, template ID/version, recipient, and immutable data snapshot. Email's unique key remains the final duplicate barrier.
4. Notification tracks intent states (`pending`, `dispatched`, `delivered`, `failed`, `suppressed`) and consumes Email delivery status events or calls Email's status API. Do not claim delivery merely because RabbitMQ accepted a job.
5. To backfill orders created before Kafka cutover, export a bounded, audited set of confirmed Order rows into **the same event contract** with deterministic IDs and an `isBackfill` marker. Verify counts by order ID. Kafka replay covers only records still retained by the topic; historical orders remain in Order's database/archive.

### 8.3 Safe route switch

Deploy Notification as a shadow consumer that stores intentions without sending. Compare its intended `notificationKey` set with the direct Order-to-Rabbit path. Stop **new** direct jobs at an Order outbox checkpoint, wait for prior direct jobs to drain, then enable Notification dispatch from the corresponding Kafka offset. For any overlap, Email's unique notification key must suppress duplicates. Record the checkpoint, counts, outstanding jobs, and rollback owner in a runbook. After verification, remove Order's email-specific publisher and queue.

Acceptance checks: Kafka consumer restart/rebalance does not duplicate notification intent; two Notification instances process each order once logically; poison messages are quarantined with an operator replay path; lag alerts fire; backfill does not resend old emails unless explicitly requested; disabling Notification leaves orders confirmed and allows recovery within retention.

## 9. Contracts and data rules to implement

Minimum wire contract examples (illustrative; final schemas belong in `packages/contracts`):

```json
{
  "eventId": "uuid",
  "eventType": "order.confirmed",
  "schemaVersion": 1,
  "aggregateId": "order-uuid",
  "occurredAt": "2026-10-13T10:00:00Z",
  "correlationId": "uuid",
  "data": {
    "orderId": "uuid",
    "customerId": "uuid",
    "eventId": "uuid",
    "quantity": 2,
    "totalAmountCents": 8000,
    "currencyCode": "EUR"
  }
}
```

```json
{
  "commandId": "uuid",
  "commandType": "email.send",
  "schemaVersion": 1,
  "notificationKey": "order-confirmation:order-uuid",
  "templateId": "order-confirmation-v1",
  "recipient": "customer@example.com",
  "data": { "orderId": "uuid", "eventName": "Example Event" }
}
```

Keep money as integer minor units and ISO currency codes; hold/order snapshots must use the same price. Consider price/version validation when a hold is created, so a catalog price change during checkout has deterministic semantics. Avoid putting card data, passwords, or full customer records into events. Record schema compatibility rules: additive optional fields within v1; breaking changes use a new version and dual-read migration. Give each message a stable ID and each consumer a unique inbox/deduplication key. Reconciliation is still required because outbox delivery is at least once and a broker cannot make database plus provider effects atomic. The [transactional outbox guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) explicitly calls out dual writes, duplicate processing, and ordering.

## 10. Infrastructure, deployment, and ownership checklist

| Concern | Minimum implementation |
| --- | --- |
| Local stack | Compose services for PostgreSQL, Elasticsearch, RabbitMQ, Kafka, and the four apps; add Kafka only in Phase 4. Declare health checks and explicit topic/queue setup; avoid relying on broker auto-creation in production. |
| Deployability | One build/image and independent rollout per service; migrations run before code that needs them; backward-compatible schema changes deployed before removal. |
| Credentials | Separate DB users, broker principals/ACLs, and secrets per service; TLS for inter-service/broker traffic in production. Internal endpoints authenticate service identity. |
| Public routing | Existing Express API routes to extracted services during migration. Add a gateway/BFF only when routing, auth, or response composition warrants an independent deployable component. Avoid duplicating business authorization: services check resource ownership. |
| Reliability | Timeouts, bounded retries with jitter, idempotency, outbox/inbox, DLQ/quarantine, reconciliation jobs, and documented manual recovery. Avoid synchronous chains for notification work. |
| Observability | HTTP latency/error rates, hold conflicts/expiry, order state age, outbox age, RabbitMQ queue depth/DLQ, Kafka group lag, provider delivery outcomes, traces by correlation ID. |
| Security/privacy | JWT issuer/audience checks, service auth, least-privilege DB roles, encrypted secrets, payload minimization, retention/deletion policy for personal data. |
| Verification | Contract checks; integration runs with actual PostgreSQL and brokers; race/failure injection for last-ticket checkout, retries, dropped responses, service outage, broker outage, and crash after publish/before ack. |
| Rollback | Per-phase traffic switch, data checkpoint, owner, and reconciliation steps. After a new service takes writes, rollback needs data replay/reconciliation before the old writer can resume. |

## 11. Implementation sequence and completion criteria

Execute phases serially: Phase 0, Order, Event, Email, Notification/Kafka. A phase is complete when the old writer has been disabled, old database privileges are removed, client contracts are respected, operational dashboards and runbooks are live, and the acceptance checks above pass. Do not begin the next extraction with two active owners of the same data.

After Phase 4, decide separately whether to extract Payment, Identity, search, or chat based on actual ownership and scaling needs. A real Payment service would own provider attempts, webhooks, refunds, and reconciliation, with a payment saga coordinated by Order. A separate API gateway is a later routing decision, not a prerequisite for these four services.

## 12. Research basis

- [AWS: Strangler fig migration](https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-decomposing-monoliths/strangler-fig.html) — incremental coexistence, cutover, rollback planning.
- [AWS: Transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) — database/broker dual-write failure and idempotent consumption.
- [Microservices.io: Database per service](https://microservices.io/patterns/data/database-per-service.html) and [Saga](https://microservices.io/patterns/data/saga.html) — data ownership and local transactions with compensating actions.
- [Apache Kafka: Log design](https://kafka.apache.org/40/design/design/) and [producer configuration](https://kafka.apache.org/41/configuration/producer-configs/) — retained log, offsets, partition ordering, producer durability/idempotence.
- [RabbitMQ: Reliability](https://www.rabbitmq.com/docs/reliability), [publisher confirms](https://www.rabbitmq.com/docs/confirms), and [quorum queues](https://www.rabbitmq.com/docs/quorum-queues) — acknowledgements, routing, message safety, retry limits.
- [OpenTelemetry: Signals](https://opentelemetry.io/docs/concepts/signals/) — distributed traces, metrics, and logs.

These sources inform the mechanisms. The phase order, temporary façade, broker placement, and Email/Notification distinction are design recommendations for this repository, not requirements imposed by the sources.
