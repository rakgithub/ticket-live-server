# Ticket Live Server

## Local services

Requirements: Docker with the Compose plugin, and pnpm.

1. Create your local environment file:

   ```sh
   cp .env.example .env
   ```

2. Start PostgreSQL and Elasticsearch:

   ```sh
   docker compose up -d
   ```

   PostgreSQL is available at `localhost:5433`, and Elasticsearch is available
   at `http://localhost:9200`. Both containers keep their data in named Docker
   volumes, so data survives container restarts.

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
the event ID and a JSON snapshot for a future search indexer. If either insert
fails, PostgreSQL rolls back both inserts.

Inspect pending outbox rows with:

```sh
docker compose exec postgres psql -U user -d ticket_live \
  -c "SELECT id, event_type, aggregate_id, payload, created_at FROM outbox_events WHERE processed_at IS NULL ORDER BY created_at;"
```

Rows remain pending until the separately started background worker processes
them. It polls every two seconds, indexes each `event.created` payload in
Elasticsearch, and marks the row as processed after Elasticsearch accepts the
document. Failed rows remain pending and include the failed attempt count and
error message.

The worker creates an Elasticsearch `events` index on first use. Elasticsearch
uses the PostgreSQL event ID as its document ID, so retrying the same outbox row
updates the same document safely.

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
