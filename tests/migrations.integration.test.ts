import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const preExtractionBoundary = "20261013135630_order_boundary_storage";
const databaseName = "ticket_live_migration_integration";
const serviceRoles = [
  "ticketlive_public_api",
  "ticketlive_identity",
  "ticketlive_order",
  "ticketlive_event",
  "ticketlive_email",
  "ticketlive_payment",
  "ticketlive_ticketing",
];

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>> | undefined;
let pool: Pool | undefined;

async function migrationDirectories(): Promise<string[]> {
  return (await readdir(resolve(process.cwd(), "drizzle"), {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function applyMigration(directory: string): Promise<void> {
  const migrationDirectory = resolve(process.cwd(), "drizzle", directory);
  const migrationFiles = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const migrationFile of migrationFiles) {
    const migration = await readFile(resolve(migrationDirectory, migrationFile), "utf8");
    const statements = migration
      .split(/--> statement-breakpoint\s*/g)
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) await pool!.query(statement);
  }
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16.15-bookworm")
    .withDatabase(databaseName)
    .withUsername("postgres")
    .withPassword("integration-admin-password")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  for (const role of serviceRoles) {
    await pool.query(`CREATE ROLE ${role} NOLOGIN`);
  }

  const directories = await migrationDirectories();
  const boundaryIndex = directories.indexOf(preExtractionBoundary);
  if (boundaryIndex < 0) throw new Error(`Migration boundary not found: ${preExtractionBoundary}`);
  for (const directory of directories.slice(0, boundaryIndex)) {
    await applyMigration(directory);
  }

  const userId = "10000000-0000-4000-8000-000000000001";
  const eventId = "20000000-0000-4000-8000-000000000002";
  const orderId = "30000000-0000-4000-8000-000000000003";
  const paymentId = "40000000-0000-4000-8000-000000000004";
  const emailEventId = "50000000-0000-4000-8000-000000000005";

  await pool.query(
    "INSERT INTO users (id, display_name, email, password_hash) VALUES ($1, $2, $3, $4)",
    [userId, "Migration Customer", "migration-customer@example.test", "synthetic-hash"],
  );
  await pool.query(
    `INSERT INTO events
      (id, name, description, location, min_people, max_people, reserved_quantity,
       ticket_price_cents, currency_code, user_id, starts_at)
     VALUES ($1, $2, $3, $4, 1, 20, 2, 3200, 'EUR', $5, $6)`,
    [eventId, "Migration Event", "Synthetic prior-schema event", "Berlin", userId, "2030-01-01T18:00:00Z"],
  );
  await pool.query(
    `INSERT INTO orders
      (id, event_id, user_id, quantity, status, ticket_price_cents, currency_code, total_amount_cents)
     VALUES ($1, $2, $3, 2, 'confirmed', 3200, 'EUR', 6400)`,
    [orderId, eventId, userId],
  );
  await pool.query(
    `INSERT INTO payments
      (id, order_id, gateway, gateway_payment_id, amount_cents, currency_code, status)
     VALUES ($1, $2, 'mock', 'migration-payment', 6400, 'EUR', 'succeeded')`,
    [paymentId, orderId],
  );
  await pool.query(
    `INSERT INTO email_deliveries (event_id, order_id, recipient_email, status)
     VALUES ($1, $2, 'migration-customer@example.test', 'simulated')`,
    [emailEventId, orderId],
  );
  await pool.query(
    `INSERT INTO outbox_events (event_type, aggregate_id, payload)
     VALUES ('order.confirmed', $1, '{"source":"prior-schema"}'::jsonb)`,
    [orderId],
  );

  for (const directory of directories.slice(boundaryIndex)) {
    await applyMigration(directory);
  }
}, 120_000);

afterAll(async () => {
  try {
    await pool?.end();
  } finally {
    await container?.stop();
  }
});

describe("service extraction migration compatibility", () => {
  it("preserves legacy records and copies receipt snapshots across the extraction boundary", async () => {
    const { rows: orders } = await pool!.query<{
      customer_name_snapshot: string;
      customer_email_snapshot: string;
      event_name_snapshot: string;
      total_amount_cents: number;
      payment_id: string;
    }>(
      `SELECT customer_name_snapshot, customer_email_snapshot, event_name_snapshot,
              total_amount_cents, payment_id
       FROM order_service.orders WHERE id = $1`,
      ["30000000-0000-4000-8000-000000000003"],
    );
    expect(orders[0]).toEqual({
      customer_name_snapshot: "Migration Customer",
      customer_email_snapshot: "migration-customer@example.test",
      event_name_snapshot: "Migration Event",
      total_amount_cents: 6_400,
      payment_id: "40000000-0000-4000-8000-000000000004",
    });

    const { rows: payments } = await pool!.query<{ status: string }>(
      "SELECT status FROM payment_service.payments WHERE order_id = $1",
      ["30000000-0000-4000-8000-000000000003"],
    );
    const { rows: events } = await pool!.query<{ name: string }>(
      "SELECT name FROM event_service.events WHERE id = $1",
      ["20000000-0000-4000-8000-000000000002"],
    );
    const { rows: deliveries } = await pool!.query<{ status: string }>(
      "SELECT status FROM email_service.email_deliveries WHERE order_id = $1",
      ["30000000-0000-4000-8000-000000000003"],
    );
    const { rows: outbox } = await pool!.query<{ event_type: string }>(
      "SELECT event_type FROM order_service.outbox_events WHERE aggregate_id = $1",
      ["30000000-0000-4000-8000-000000000003"],
    );

    expect(payments).toEqual([{ status: "succeeded" }]);
    expect(events).toEqual([{ name: "Migration Event" }]);
    expect(deliveries).toHaveLength(1);
    expect(outbox).toEqual([{ event_type: "order.confirmed" }]);
  });
});
