import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseName = "ticket_live_event_integration";
const eventPassword = "integration-event-password";
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
let adminPool: Pool | undefined;
let eventPool: Pool | undefined;
let createEvent: typeof import("./services/eventsService.ts")["createEvent"];
let createInventoryHold: typeof import("./services/inventoryHoldsService.ts")["createInventoryHold"];
let expireExpiredInventoryHolds: typeof import("./services/inventoryHoldsService.ts")["expireExpiredInventoryHolds"];

async function applyRepositoryMigrations(pool: Pool): Promise<void> {
  const migrationsDirectory = resolve(process.cwd(), "drizzle");
  const migrationDirectories = (await readdir(migrationsDirectory, {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const migrationDirectory of migrationDirectories) {
    const directoryPath = resolve(migrationsDirectory, migrationDirectory);
    const migrationFiles = (await readdir(directoryPath))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const migrationFile of migrationFiles) {
      const migration = await readFile(
        resolve(directoryPath, migrationFile),
        "utf8",
      );
      const statements = migration
        .split(/--> statement-breakpoint\s*/g)
        .map((statement) => statement.trim())
        .filter(Boolean);

      for (const statement of statements) await pool.query(statement);
    }
  }
}

beforeAll(async () => {
  process.env.TICKETLIVE_SERVICE = "event";
  process.env.NODE_ENV = "test";
  process.env.CORS_ORIGINS = "http://localhost:3000";
  container = await new PostgreSqlContainer("postgres:16.15-bookworm")
    .withDatabase(databaseName)
    .withUsername("postgres")
    .withPassword("integration-admin-password")
    .start();

  const adminUrl = container.getConnectionUri();
  adminPool = new Pool({ connectionString: adminUrl });
  for (const role of serviceRoles) {
    await adminPool.query(`CREATE ROLE ${role} NOLOGIN`);
  }
  await adminPool.query(
    "ALTER ROLE ticketlive_event LOGIN PASSWORD 'integration-event-password'",
  );
  await applyRepositoryMigrations(adminPool);

  const eventUrl = new URL(adminUrl);
  eventUrl.username = "ticketlive_event";
  eventUrl.password = eventPassword;
  process.env.EVENT_SERVICE_DATABASE_URL = eventUrl.toString();

  const [eventsModule, holdsModule, databaseModule] = await Promise.all([
    import("./services/eventsService.ts"),
    import("./services/inventoryHoldsService.ts"),
    import("./db/client.ts"),
  ]);
  createEvent = eventsModule.createEvent;
  createInventoryHold = holdsModule.createInventoryHold;
  expireExpiredInventoryHolds = holdsModule.expireExpiredInventoryHolds;
  eventPool = databaseModule.pool;
}, 120_000);

afterAll(async () => {
  try {
    await eventPool?.end();
  } finally {
    try {
      await adminPool?.end();
    } finally {
      await container?.stop();
    }
  }
});

describe("Event inventory integration", () => {
  it("serializes competing holds and releases capacity when a hold expires", async () => {
    const ownerId = randomUUID();
    const event = await createEvent(ownerId, {
      name: "Integration event",
      description: "Synthetic event for database integration testing",
      location: "Berlin",
      minPeople: 1,
      maxPeople: 5,
      ticketPriceCents: 2_500,
      currencyCode: "EUR",
      servesAlcohol: false,
      startsAt: new Date("2030-01-01T18:00:00.000Z"),
    });

    const holdRequests = [randomUUID(), randomUUID()].map((orderId) =>
      createInventoryHold({ eventId: event.id, orderId, quantity: 4 }),
    );
    const outcomes = await Promise.allSettled(holdRequests);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

    const { rows: activeHolds } = await adminPool!.query<{ order_id: string }>(
      "SELECT order_id FROM event_service.inventory_holds WHERE event_id = $1 AND state = 'active'",
      [event.id],
    );
    const activeHold = activeHolds[0];
    expect(activeHold).toBeDefined();

    await adminPool!.query(
      "UPDATE event_service.inventory_holds SET expires_at = now() - interval '1 second' WHERE order_id = $1",
      [activeHold!.order_id],
    );
    await expect(expireExpiredInventoryHolds()).resolves.toBe(4);

    const { rows: storedEvents } = await adminPool!.query<{ reserved_quantity: number }>(
      "SELECT reserved_quantity FROM event_service.events WHERE id = $1",
      [event.id],
    );
    const storedEvent = storedEvents[0];
    expect(storedEvent?.reserved_quantity).toBe(0);
  });
});
