# Service deployment baseline

This repository provides a provider-neutral container image and local Compose
stack. It does not include cloud-specific infrastructure definitions. Build the
root Dockerfile once per revision and roll out the same image independently
with `TICKETLIVE_SERVICE` set to `public-api`, `order`, `event`, or `email`.

## Deployment order

1. Build and publish the reviewed application image. Keep the image digest and
   source revision in the deployment record.
2. Take a recoverable database snapshot and record current migration versions,
   queue depths, and service versions.
3. Build and run the Dockerfile's `migrations` target as a one-shot migration
   job with `MIGRATION_DATABASE_URL` (locally:
   `docker compose --profile tooling run --rm migrations`). The API and service
   startup commands never apply migrations. Add nullable columns/tables first, deploy compatible readers
   and writers, backfill, then remove old columns only after every old binary is
   drained.
4. Provision broker topology and service credentials before starting Order or
   Email. Set `RABBITMQ_AUTO_DECLARE_TOPOLOGY=false` on both production
   services; they must fail against missing queues instead of creating
   production topology implicitly.
5. Roll out Event and Email, then Order, then the public API gateway. Verify
   each `/health/ready`, `/metrics`, service logs, RabbitMQ consumers, and
   outbox age before sending traffic. The API readiness endpoint checks its
   identity database and Event and Order readiness.
6. Keep one Order service instance until outbox row claiming is implemented.
   The relay/reconciliation loop is in-process and currently has no cross-replica
   claim lock.

The local application profile uses a fake Email provider and the production
configuration deliberately rejects it. Do not deploy the Email service to
production until a real provider, sender verification, webhook policy, and
delivery/replay behavior have been implemented and reviewed.

## Runtime identity and secret assignment

Use a secrets manager or equivalent runtime secret injection. Do not store
production values in Compose files, image layers, logs, or the repository.
Generate independent random service tokens; each value must be at least 32
printable ASCII bytes. The old `INTERNAL_SERVICE_TOKEN` is a development-only
fallback and is rejected for production.

| Runtime | Database credential | Internal credential | Broker credential |
| --- | --- | --- | --- |
| Public API | `DATABASE_URL` with identity/public tables only | `PUBLIC_API_ORDER_TOKEN`, `PUBLIC_API_EVENT_TOKEN` | None |
| Order | `ORDER_SERVICE_DATABASE_URL` for `order_service` | `ORDER_EVENT_TOKEN` | `ORDER_AMQP_URL` user may publish only to `ticket-live.email` |
| Event | `EVENT_SERVICE_DATABASE_URL` for `event_service` | `PUBLIC_API_EVENT_TOKEN`, `ORDER_EVENT_TOKEN` | None |
| Email | `EMAIL_SERVICE_DATABASE_URL` for `email_service` | `EMAIL_INTERNAL_TOKEN` | `EMAIL_AMQP_URL` user consumes Email commands and publishes retry/dead-letter messages |

Set `ORDER_SERVICE_URL` and `EVENT_SERVICE_URL` to private service addresses.
Set `INVENTORY_SERVICE_URL` on Order to its private Event address as well. URL
encode reserved characters in database and broker credentials.
The public API is the HTTP gateway: it verifies the user's JWT, reads the
customer name and email from its identity database, and passes only those
fields plus the authenticated user ID to Order. Order owns checkout state and
checks Event resource state through the authenticated Order-to-Event token.
Preserve issuer/audience validation on public JWTs and keep authorization rules
in the owning domain service for any future resource-owned endpoint.

## Network and transport

Use private service networking for internal endpoints and RabbitMQ. Terminate
public HTTPS at a trusted ingress or service mesh and set
`TRUST_PROXY_HOPS` to the exact trusted proxy count. Use HTTPS service URLs,
PostgreSQL TLS (`sslmode=require` or stricter), and `amqps://` broker URLs in
production. Restrict the RabbitMQ management API and Prometheus endpoints to
operator/monitoring networks. The local Compose stack binds host ports to
loopback, disables Elasticsearch security, and does not enable TLS; those
settings are for local development only.

## RabbitMQ provisioning and permissions

Import [`../ops/rabbitmq/topology.json`](../ops/rabbitmq/topology.json) with an
operator credential before deploying services. It provisions the durable
`ticket-live.email`, retry, and dead-letter exchanges; `email.send.v1`, retry,
dead-letter, and legacy queues; and their bindings. The retry queue TTL is
30 seconds to match `EMAIL_RETRY_DELAY_MS`; provision the matching TTL if the
configured delay changes. Keep `booking-confirmation-email` until Phase 4's
queue drain is verified.

Production broker ACLs should omit configure permission from both runtime
principals:

| Principal | Configure | Write | Read |
| --- | --- | --- | --- |
| Order | none | `^ticket-live\.email$` | none |
| Email | none | `^ticket-live\.email\.(retry|dead)$` | `^(email\.send\.v1|booking-confirmation-email)$` |

The local bootstrap script gives the applications enough configure access to
declare topology for developer convenience. Its local credentials are not a
production ACL template. Production uses the explicit definitions file,
separately managed credentials, and `RABBITMQ_AUTO_DECLARE_TOPOLOGY=false`.

## Observability and recovery

Prometheus scrapes each service's HTTP histograms and service metrics. Order
reports unresolved order age, outbox backlog, and Order/Event reconciliation mismatches. Event reports
active hold count/age, capacity conflicts, and expiry totals. Email reports
provider/delivery outcomes. RabbitMQ metrics provide queue depth, oldest
message age, dead letters, and consumer count. Propagate `x-correlation-id`,
`traceparent`, and `tracestate` across service calls; configure the OTLP
collector with `OTEL_EXPORTER_OTLP_ENDPOINT` and secret headers where needed.

For an outage, preserve pending outbox rows and broker messages. Restore the
affected service or dependency, let bounded retries and reconciliation run,
then inspect metrics and state before any manual replay. Use the audited
one-order Email replay procedure in [`phase-4-cutover.md`](phase-4-cutover.md).
Do not replay an Email command until its provider outcome is known.

## Rollback and ownership

Every rollout record should name a service owner, deployment owner, migration
position, snapshot, traffic switch, and reconciliation owner. Before reversing
a traffic switch, stop new writes on the new owner and compare its latest
committed IDs/outbox rows with the rollback target. Replay or reconcile accepted
writes before an older writer resumes. Do not point traffic back to a service
that cannot see writes made after ownership moved. The detailed Order, Event,
and Email traffic switches are in [`phase-1-cutover.md`](phase-1-cutover.md),
[`phase-2-cutover.md`](phase-2-cutover.md),
[`phase-3-cutover.md`](phase-3-cutover.md), and
[`phase-4-cutover.md`](phase-4-cutover.md).
