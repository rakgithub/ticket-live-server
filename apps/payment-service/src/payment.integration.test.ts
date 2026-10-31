import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseName = "ticket_live_payment_integration";
const paymentPassword = "integration-payment-password";
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
let paymentPool: Pool | undefined;
let chargePayment: typeof import("./services/paymentService.ts")["chargePayment"];

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
  process.env.TICKETLIVE_SERVICE = "payment";
  process.env.NODE_ENV = "test";
  process.env.CORS_ORIGINS = "http://localhost:3000";
  process.env.MOCK_PAYMENT_DELAY_MS = "0";
  process.env.MOCK_PAYMENT_FAILURE_RATE = "0";
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
    "ALTER ROLE ticketlive_payment LOGIN PASSWORD 'integration-payment-password'",
  );
  await applyRepositoryMigrations(adminPool);

  const paymentUrl = new URL(adminUrl);
  paymentUrl.username = "ticketlive_payment";
  paymentUrl.password = paymentPassword;
  process.env.PAYMENT_SERVICE_DATABASE_URL = paymentUrl.toString();

  const [serviceModule, databaseModule] = await Promise.all([
    import("./services/paymentService.ts"),
    import("./db/client.ts"),
  ]);
  chargePayment = serviceModule.chargePayment;
  paymentPool = databaseModule.pool;
}, 120_000);

afterAll(async () => {
  try {
    await paymentPool?.end();
  } finally {
    try {
      await adminPool?.end();
    } finally {
      await container?.stop();
    }
  }
});

describe("Payment persistence integration", () => {
  it("deduplicates retries by order ID and rejects changed charge details", async () => {
    const request = {
      orderId: randomUUID(),
      amountCents: 6_400,
      currencyCode: "EUR",
    };

    const first = await chargePayment(request);
    const retry = await chargePayment(request);

    expect(retry).toEqual(first);
    await expect(
      chargePayment({ ...request, amountCents: request.amountCents + 1 }),
    ).rejects.toThrow("Order already has a payment with different amount details");

    const { rows } = await adminPool!.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM payment_service.payments WHERE order_id = $1",
      [request.orderId],
    );
    expect(rows[0]?.count).toBe("1");
  });
});
