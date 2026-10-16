# Phase 3 Email service cutover

This runbook moves email delivery records and consumption into the Email
service. It prepares the migration and routing procedure; applying the database
migration and changing a live deployment are operator actions.

## Prepare

1. Confirm the Email service has its own `EMAIL_SERVICE_DATABASE_URL` using the
   `ticketlive_email` role, RabbitMQ access, and the internal service token.
   The service needs no Order or Event database credentials. Local development
   uses `EMAIL_PROVIDER=fake`; it records provider acceptance without sending
   email.
2. Take a recoverable PostgreSQL snapshot and record the database version,
   current migration position, Email deployment version, and RabbitMQ queue
   counts.
3. Review the pending Drizzle migration. It moves the existing
   `email_deliveries` table into `email_service`, preserves row IDs, maps old
   `sent` rows to `accepted_by_provider`, retains simulated rows, and assigns
   table ownership to `ticketlive_email`. Apply it with `MIGRATION_DATABASE_URL`
   only after the snapshot is verified.
4. Verify that historical rows remain queryable and that the Email role can
   read and write `email_service.email_deliveries`. Confirm the public API role
   no longer has write access to that table.

## Switch consumers

1. Start Email with its service database URL and `EMAIL_LEGACY_QUEUE_ENABLED=true`.
   Confirm `/health/ready` reports both PostgreSQL and RabbitMQ ready.
2. Keep the Order outbox worker running. It publishes new jobs to the durable
   `email.send.v1` queue. The Email consumer also drains old jobs from
   `booking-confirmation-email` while the compatibility flag is enabled.
3. Check both queues in RabbitMQ. Leave the compatibility consumer enabled
   until `booking-confirmation-email` has zero ready and zero unacknowledged
   messages, and confirm no older deployment is still publishing to it. Then
   set `EMAIL_LEGACY_QUEUE_ENABLED=false` and restart Email.
4. Verify one duplicate command produces one logical delivery row, provider
   acceptance is visible through the service-authenticated
   `GET /internal/deliveries/{notificationKey}`, and checkout still completes
   while Email or RabbitMQ is unavailable.

Example queue inspection in the RabbitMQ management UI uses these queue names:

- `email.send.v1`
- `email.send.v1.retry`
- `email.send.v1.dlq`
- `booking-confirmation-email` during the compatibility drain

## Retries and dead letters

Transient failures are routed to `email.send.v1.retry`, which waits for
`EMAIL_RETRY_DELAY_MS` before returning the command to `email.send.v1`. A
bounded number of attempts is controlled by `EMAIL_MAX_RETRIES`. Malformed
commands, permanent provider failures, and exhausted retries go to
`email.send.v1.dlq`; they are not immediately requeued forever. Prometheus
scrapes RabbitMQ's `rabbitmq_prometheus` plugin for queue depth and oldest
message timestamps, and the Email `/metrics` endpoint for delivery attempts
and provider outcomes. The Phase 4 rules and dashboard alert on old messages
and non-empty DLQ state. The message header `x-email-first-failed-at` records
when retrying began.

To inspect a DLQ message, use the RabbitMQ management UI's non-destructive
message view and verify the dead-letter reason, command ID, notification key,
and failure age. Do not copy recipient addresses or message bodies into logs or
incident notes. After fixing the underlying issue, republish the validated
command to exchange `ticket-live.email` with routing key `email.send.v1`, set
header `x-email-replay=true`, and reset `x-email-retry-count` to `0`. Preserve
the original `notificationKey` so the database and provider idempotency key
continue to suppress duplicates. For an unknown provider outcome, reconcile
with the provider by idempotency key/message ID before replay; if the real
provider cannot do that safely, leave the message quarantined for manual
resolution.

## Provider readiness and acceptance

No real email provider or webhook is configured in this repository. Production
Email startup therefore refuses the fake adapter. Before enabling real sends,
select a provider, provision credentials and a verified sender/domain, define
delivery and retry policy, and implement its authenticated delivery/bounce
webhook. `accepted_by_provider` means the provider accepted the message; only a
verified callback should move it to `delivered` or `bounced`. Broker delivery
alone cannot guarantee exactly-once email delivery.

Record the command, notification key, delivery row, and queue counts for these
checks:

| Scenario | Required result |
| --- | --- |
| Duplicate command or worker crash before acknowledgment | One logical delivery exists; the stable notification key prevents a second send when supported by the provider. |
| Transient provider failure | A delayed retry is scheduled and the attempt count stays bounded. |
| Malformed command or exhausted retries | The command reaches the DLQ and can be inspected and replayed after a fix. |
| Provider timeout | The worker checks provider state or retries only with the same supported idempotency key; otherwise it quarantines the unknown outcome. |
| Legacy queue drain | Compatibility consumption is disabled only after ready and unacknowledged counts remain zero and old publishers are stopped. |
| Historical data | Existing simulated records and IDs remain queryable in `email_service`. |
| Provider callback | Pending real-provider integration: verified callbacks update delivery state without treating provider acceptance as inbox delivery. |

## Rollback

Stop new Email consumers before changing ownership or queue routing. Keep the
Email schema and all post-cutover rows intact. Restore an older deployment only
after it can safely read the moved schema and preserve the unique notification
key; do not move the table back or restore a snapshot over new delivery rows
without an explicit reconciliation and data-loss decision.
