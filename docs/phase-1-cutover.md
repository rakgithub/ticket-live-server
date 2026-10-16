# Phase 1 checkout and email cutover

This runbook applies the temporary Event-owned inventory API, Order checkout
state machine, and temporary Order-to-Email command path. It is an operator
procedure: it does not grant the integrated public API a service-owned database
credential automatically.

## Before the cutover

1. Review and apply the pending Drizzle migrations with `MIGRATION_DATABASE_URL`.
   Back up the database first. Do not use `db:clear`.
2. Reconcile the original order IDs, payment IDs, statuses, price snapshots, and
   `order_service.outbox_events` count against the pre-cutover source. Any
   mismatch blocks the write switch.
3. Deploy the email worker before deploying the outbox relay. Confirm it is
   consuming both `booking-confirmation-email` and `email.send.v1`.
4. Pause or drain checkout writes for the brief routing change. Record the
   deployment version, time, and the highest existing Order outbox event ID.

## Cutover

1. Deploy the checkout state machine and route new checkout traffic to it.
2. Start one outbox worker. It relays `order.confirmed` as `email.send.v1` and
   does not mark an outbox row processed until RabbitMQ confirms the routed,
   persistent command.
3. Resume checkout traffic. Keep the legacy email consumer running until
   `booking-confirmation-email` reports zero ready and zero unacknowledged
   messages for a full worker polling interval.
4. After the separate Order runtime uses its own database login, revoke the old
   application's INSERT, UPDATE, and DELETE privileges on `order_service`.
   Record the deployed credential and privilege query with the cutover record.

## Acceptance record

Run the checkout scenarios with isolated events and retain order, hold, payment,
outbox event, and notification-key IDs for each result:

| Scenario | Required result |
| --- | --- |
| Parallel final-ticket checkouts | Confirmed holds and orders never exceed capacity. |
| Repeated request with one idempotency key | One Order and one Event hold exist. |
| Timeout after creating a hold | Retry with the same key recovers the original hold and Order. |
| Mock payment failure | Order is cancelled and the hold release command reaches Event. |
| Payment success with an ambiguous hold response | The Order is reconciled or becomes `reconciliation_required`; it never confirms a dead hold. |
| Hold expiry during payment | The Order is expired or requires reconciliation; it never becomes normally confirmed. |
| Outbox retry after a broker-confirmed publish | One logical `notificationKey` exists in `email_deliveries`. |
| Existing public checkout client | The documented, versioned HTTP response remains compatible. |

## Rollback

Stop routing new checkout requests to the new path before reversing traffic. Do
not restore old ownership writes after the new path has accepted writes until an
operator reconciles the post-cutover orders, payments, holds, and outbox rows by
their stable IDs. The legacy email queue can remain consumed while that
reconciliation is performed; its notification-key unique constraint suppresses
duplicate confirmation intents.
