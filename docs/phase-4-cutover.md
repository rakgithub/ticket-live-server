# Phase 4 Order-to-Email hardening

This runbook covers production setup, historical confirmation replay, and the
legacy queue drain. Applying migrations and changing deployed configuration
are operator actions. Keep one Order outbox worker active until Order rows are
claimed safely across multiple workers.

## Prepare and deploy

1. Take a recoverable PostgreSQL snapshot. Record the database version,
   migration position, Order and Email deployment versions, and RabbitMQ queue
   counts.
2. Review the migration creating
   `order_service.email_replay_audits`; apply reviewed Drizzle migrations with
   `MIGRATION_DATABASE_URL` before deploying code that writes replay audits.
3. Configure the Order worker and replay command with
   `TICKETLIVE_SERVICE=order`, `ORDER_SERVICE_DATABASE_URL` using the
   `ticketlive_order` role, and `AMQP_URL`. Keep the public API and Email
   service on their own database URLs.
4. Enable RabbitMQ's `rabbitmq_prometheus` plugin and expose its scrape
   endpoint only to the monitoring network. Scrape its detailed
   endpoint for the `/` virtual host. Prometheus also scrapes the public API
   and Email `/metrics`; import
   `ops/grafana/ticket-live-phase-0-dashboard.json` and load
   `ops/prometheus/alerts.yml`.
5. Confirm the legacy publisher has been stopped. Leave
   `EMAIL_LEGACY_QUEUE_ENABLED=true` until the old queue has zero ready and
   zero unacknowledged messages. Then record the cutover evidence below, set
   the flag to `false` in the deployed Email environment, and restart Email.
   The compatibility code remains available for a controlled rollback while
   needed.

Record the drain before changing the flag:

| Field | Value |
| --- | --- |
| Deployment / environment | |
| Email deployment version | |
| Legacy publisher stopped at | |
| Queue ready count | `0` |
| Queue unacknowledged count | `0` |
| Checked at (UTC) | |
| Operator | |
| Change / incident reference | |

Recheck that no old publisher is active immediately before setting the flag.
If a publisher or queued message remains, keep compatibility consumption
enabled and resolve it before proceeding.

## Audited historical confirmation replay

Replay one confirmed order per invocation. The tool validates a dry run by
default. It only reads the immutable `order.confirmed` outbox snapshot after
confirming the order is still `confirmed`; it preserves the original outbox
ID as `commandId` and the original `order-confirmation:{orderId}` key. Email's
dedupe store suppresses a duplicate accepted delivery, and the replay header
permits a failed delivery to be retried after its cause is fixed.

First validate without publishing:

```sh
TICKETLIVE_SERVICE=order pnpm exec tsx src/scripts/replayOrderConfirmation.ts \
  --order-id 00000000-0000-4000-8000-000000000000 \
  --requested-by on-call-operator \
  --reason INC-123
```

After inspecting the dry run and fixing the delivery cause, publish with
`--apply`:

```sh
TICKETLIVE_SERVICE=order pnpm exec tsx src/scripts/replayOrderConfirmation.ts \
  --order-id 00000000-0000-4000-8000-000000000000 \
  --requested-by on-call-operator \
  --reason INC-123 \
  --apply
```

Each applied run records the order ID, original outbox ID, notification key,
operator-supplied identity and reason, status, and error type in
`order_service.email_replay_audits`. Inspect attempts without customer data:

```sql
SELECT id, order_id, outbox_event_id, notification_key, requested_by, reason,
       status, error_type, requested_at, finished_at
FROM order_service.email_replay_audits
ORDER BY requested_at DESC;
```

If the tool reports a failed publish, inspect the audit row and queue before
retrying: a connection can fail after RabbitMQ accepted a message. Reusing the
same command ID and notification key is safe, but do not assume a delivery
failed solely from a missing publisher confirm. For unknown provider outcomes,
reconcile with the provider before any replay.

DLQ inspection and manual replay remain available in
[`phase-3-cutover.md`](phase-3-cutover.md). Keep the same command ID and
notification key, set `x-email-replay=true`, and reset the retry count only
after fixing the failure.

## Metrics and alerts

Prometheus scrapes the following local endpoints; use the corresponding host
and service names in production:

| Target | Signal |
| --- | --- |
| Public API `/metrics` | Pending Order outbox count and age |
| Email `/metrics` | Delivery rows by status, durable attempts, provider outcomes, unknown provider outcomes |
| RabbitMQ `:15692/metrics/detailed` | Queue depth, consumer count, and oldest-message timestamp for each queue |

Alert rules cover main/retry queue depth and age, a non-empty or old DLQ,
queued commands without a consumer, failed provider outcomes, unknown provider
outcomes, and the existing Order outbox age. Check dashboard health and alert
delivery after deployment. Do not run more than one Order relay until it uses
database row claims or `FOR UPDATE SKIP LOCKED`.

## Acceptance and rollback

Verify in the deployed environment that broker outages leave confirmation
outbox rows pending while checkout still completes, a relay duplicate leaves
one logical Email delivery, and DLQ commands can be inspected and replayed.
Record IDs and timestamps without copying recipient addresses or message
bodies. Phase 4 is not cut over until the legacy drain table is complete and
the deployed Email service has restarted with the compatibility consumer
disabled.

For rollback, restore `EMAIL_LEGACY_QUEUE_ENABLED=true` only if the rollback
publisher needs the legacy queue and after checking queue contents. Do not
purge queues or reset the database as part of rollback.
