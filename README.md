# Ticket Live Server

Ticket Live is a Node.js API for an event ticket booking app. Users can register
and sign in, create and search events, and check out tickets. The API stores
events and orders in PostgreSQL, uses Elasticsearch for event search, and uses
a mock payment provider for checkout. After an order is confirmed, a background
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

   PostgreSQL is available at `localhost:5433`, Elasticsearch at
   `http://localhost:9200`, and RabbitMQ at `localhost:5672`. RabbitMQ's
   management dashboard is at `http://localhost:15672` (`guest` / `guest`).
   The services keep their data in named Docker volumes, so it survives
   container restarts.

3. Apply the checked-in Drizzle migrations:

   ```sh
   pnpm exec drizzle-kit migrate
   ```

4. Start the API server in one terminal:

   ```sh
   pnpm start
   ```

5. Start the outbox worker in a second terminal:

   ```sh
   pnpm start:worker
   ```

   The API listens at `http://localhost:4002`. The worker has no HTTP port; it
   polls PostgreSQL and writes pending event documents to Elasticsearch.

6. Start the email worker in a third terminal:

   ```sh
   pnpm start:email-worker
   ```

   It listens on RabbitMQ's `booking-confirmation-email` queue and currently
   records simulated email deliveries in PostgreSQL. It does not send real
   email or generate PDFs yet.

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
`outbox_events` within the same PostgreSQL transaction. The outbox row contains
the event ID and a JSON snapshot for indexing. If either insert fails,
PostgreSQL rolls back both inserts.

After a checkout payment succeeds, the order, payment, and `order.confirmed`
outbox row are committed in one PostgreSQL transaction. The API can then return
the confirmed order without waiting for RabbitMQ or background email handling.

Inspect pending outbox rows with:

```sh
docker compose exec postgres psql -U user -d ticket_live \
  -c "SELECT id, event_type, aggregate_id, payload, created_at FROM outbox_events WHERE processed_at IS NULL ORDER BY created_at;"
```

Rows remain pending until the separately started background worker processes
them. It polls every two seconds and routes each event by type:

- `event.created` is indexed directly in Elasticsearch.
- `order.confirmed` is published to RabbitMQ for the email worker.

The worker marks an outbox row processed after its destination accepts the
event. Failed rows remain pending and include the failed attempt count and
error message.

The worker creates an Elasticsearch `events` index on first use. Elasticsearch
uses the PostgreSQL event ID as its document ID, so retrying the same outbox row
updates the same document safely.

The email worker validates each `order.confirmed` message, then inserts a row in
`email_deliveries` with status `simulated`. It uses the outbox event ID to avoid
recording the same delivery twice. To inspect those records:

```sh
docker compose exec postgres psql -U user -d ticket_live \
  -c "SELECT order_id, recipient_email, status, created_at FROM email_deliveries ORDER BY created_at DESC;"
```

The RabbitMQ test publisher and consumer under `src/scripts/` are development
helpers. The test consumer reads from the same queue as the email worker, so do
not leave it running while processing real confirmation messages.

## Event search

`GET /events/search` queries Elasticsearch instead of PostgreSQL. It requires
the same access token as other event routes and supports a required `q` query
parameter plus an optional `limit` from 1 to 50:

```text
GET /events/search?q=berlin%20music&limit=20
```

The search checks event names, descriptions, and locations. Name matches rank
highest, cancelled events are excluded, and Elasticsearch returns the remaining
results by relevance and then by event start time.
