import { createServer, type Server } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseName = "ticket_live_order_integration";
const orderPassword = "integration-order-password";
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
let orderPool: Pool | undefined;
let eventServer: Server | undefined;
let paymentServer: Server | undefined;
let reconciliation: typeof import("./services/orders/checkoutService.ts")["reconcileCheckoutState"];
let checkout: typeof import("./services/orders/checkoutService.ts")["checkout"];
let eventResponseStatus = 200;
let dropCreateResponses = 0;
let createHoldCalls = 0;
let confirmHoldCalls = 0;
let paymentCalls = 0;
const holds = new Map<string, Record<string, unknown>>();

const eventId = "1dc646c7-bd99-4bd5-9537-df2c61d23e96";
const paymentRecords = new Map<string, {
  id: string;
  orderId: string;
  status: "succeeded";
  gateway: "mock";
}>();

function holdResponse(
  holdId: string,
  requestedEventId = eventId,
  quantity = 1,
  state = "active",
): Record<string, unknown> {
  const now = new Date("2029-12-01T10:00:00.000Z");
  return {
    holdId,
    orderId: holdId,
    eventId: requestedEventId,
    eventNameSnapshot: "Integration event",
    eventLocationSnapshot: "Berlin",
    quantity,
    unitPriceCents: 6_400,
    currencyCode: "EUR",
    eventStartsAtSnapshot: "2030-01-01T18:00:00.000Z",
    state,
    expiresAt: "2030-01-01T17:00:00.000Z",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

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
  process.env.TICKETLIVE_SERVICE = "order";
  process.env.NODE_ENV = "test";
  process.env.CORS_ORIGINS = "http://localhost:3000";
  process.env.ORDER_EVENT_TOKEN = "integration-order-event-token-1234567890";
  process.env.ORDER_PAYMENT_TOKEN = "integration-order-payment-token-1234567890";

  eventServer = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const createMatch = path.match(/^\/internal\/events\/([^/]+)\/holds$/);
    const holdMatch = path.match(/^\/internal\/holds\/([^/]+)$/);
    const confirmMatch = path.match(/^\/internal\/holds\/([^/]+)\/confirm$/);

    if (request.method === "POST" && createMatch) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          orderId: string;
          quantity: number;
        };
        createHoldCalls += 1;
        const hold = holds.get(body.orderId) ?? holdResponse(
          body.orderId,
          createMatch[1],
          body.quantity,
        );
        holds.set(body.orderId, hold);

        if (dropCreateResponses > 0) {
          dropCreateResponses -= 1;
          response.destroy();
          return;
        }
        sendJson(response, 200, { hold });
      });
      return;
    }

    if (holdMatch && request.method === "GET") {
      if (eventResponseStatus !== 200) {
        sendJson(response, eventResponseStatus, { error: "Event service unavailable" });
        return;
      }
      const holdId = holdMatch[1]!;
      const hold = holds.get(holdId) ?? holdResponse(holdId);
      sendJson(response, 200, { hold });
      return;
    }

    if (confirmMatch && request.method === "POST") {
      const holdId = confirmMatch[1]!;
      const hold = holdResponse(holdId, eventId, 2, "confirmed");
      holds.set(holdId, hold);
      confirmHoldCalls += 1;
      sendJson(response, 200, { hold });
      return;
    }

    sendJson(response, 404, { error: "Unknown Event integration route" });
  });
  await new Promise<void>((resolveListen, reject) => {
    eventServer!.once("error", reject);
    eventServer!.listen(0, "127.0.0.1", resolveListen);
  });
  const address = eventServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Event stub did not bind to a TCP port");
  }
  process.env.INVENTORY_SERVICE_URL = `http://127.0.0.1:${address.port}`;

  paymentServer = createServer((request, response) => {
    const paymentPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const orderPaymentMatch = paymentPath.match(/^\/internal\/payments\/([^/]+)$/);
    if (request.method === "GET" && orderPaymentMatch) {
      const record = paymentRecords.get(orderPaymentMatch[1]!);
      if (!record) {
        sendJson(response, 404, { error: "Payment not found" });
        return;
      }
      sendJson(response, 200, record);
      return;
    }

    if (request.method !== "POST" || paymentPath !== "/internal/payments") {
      sendJson(response, 404, { error: "Unknown Payment integration route" });
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        orderId: string;
      };
      paymentCalls += 1;
      const record = {
        id: randomUUID(),
        orderId: body.orderId,
        status: "succeeded" as const,
        gateway: "mock" as const,
      };
      paymentRecords.set(body.orderId, record);
      sendJson(response, 200, record);
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    paymentServer!.once("error", reject);
    paymentServer!.listen(0, "127.0.0.1", resolveListen);
  });
  const paymentAddress = paymentServer.address();
  if (!paymentAddress || typeof paymentAddress === "string") {
    throw new Error("Payment stub did not bind to a TCP port");
  }
  process.env.PAYMENT_SERVICE_URL = `http://127.0.0.1:${paymentAddress.port}`;

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
    "ALTER ROLE ticketlive_order LOGIN PASSWORD 'integration-order-password'",
  );
  await applyRepositoryMigrations(adminPool);

  const orderUrl = new URL(adminUrl);
  orderUrl.username = "ticketlive_order";
  orderUrl.password = orderPassword;
  process.env.ORDER_SERVICE_DATABASE_URL = orderUrl.toString();

  const [checkoutModule, databaseModule] = await Promise.all([
    import("./services/orders/checkoutService.ts"),
    import("./db/client.ts"),
  ]);
  reconciliation = checkoutModule.reconcileCheckoutState;
  checkout = checkoutModule.checkout;
  orderPool = databaseModule.pool;
}, 120_000);

afterAll(async () => {
  try {
    await orderPool?.end();
  } finally {
    try {
      await adminPool?.end();
    } finally {
      try {
        await container?.stop();
      } finally {
        for (const server of [paymentServer, eventServer]) {
          await new Promise<void>((resolveClose, reject) => {
            if (!server?.listening) return resolveClose();
            server.close((error) => error ? reject(error) : resolveClose());
          });
        }
      }
    }
  }
});

describe("Order checkout reconciliation integration", () => {
  it("recovers an ambiguous hold response and returns the same result for an idempotent retry", async () => {
    eventResponseStatus = 200;
    createHoldCalls = 0;
    confirmHoldCalls = 0;
    paymentCalls = 0;
    paymentRecords.clear();
    dropCreateResponses = 3;
    holds.clear();

    const userId = randomUUID();
    const idempotencyKey = `integration-${randomUUID()}`;
    const input = { eventId, quantity: 2 };
    const customer = { name: "Integration Customer", email: "customer@example.test" };
    const response = await checkout(userId, input, idempotencyKey, customer);

    expect(response.order).toMatchObject({
      eventId,
      quantity: 2,
      status: "confirmed",
      ticketPriceCents: 6_400,
      totalAmountCents: 12_800,
    });
    expect(createHoldCalls).toBeGreaterThan(1);
    expect(confirmHoldCalls).toBe(1);
    expect(paymentCalls).toBe(1);

    await expect(checkout(userId, input, idempotencyKey, customer)).resolves.toEqual(response);
    await expect(
      checkout(userId, { ...input, quantity: 1 }, idempotencyKey, customer),
    ).rejects.toMatchObject({ status: 409 });
    expect(paymentCalls).toBe(1);

    const { rows: attempts } = await adminPool!.query<{ state: string; response_status: number }>(
      "SELECT state, response_status FROM order_service.checkout_attempts WHERE user_id = $1 AND idempotency_key = $2",
      [userId, idempotencyKey],
    );
    expect(attempts).toEqual([{ state: "succeeded", response_status: 201 }]);
  });

  it("fails an orphaned checkout and records a release when Event confirms its hold", async () => {
    eventResponseStatus = 200;
    const attemptId = randomUUID();
    const orderId = randomUUID();
    await adminPool!.query(
      `INSERT INTO order_service.checkout_attempts
        (id, user_id, idempotency_key, request_hash, order_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, now() - interval '2 minutes')`,
      [attemptId, randomUUID(), `key-${attemptId}`, "a".repeat(64), orderId],
    );

    await expect(reconciliation()).resolves.toBe(1);

    const { rows: attempts } = await adminPool!.query<{
      state: string;
      response_status: number;
    }>("SELECT state, response_status FROM order_service.checkout_attempts WHERE id = $1", [attemptId]);
    expect(attempts[0]).toEqual({ state: "failed", response_status: 500 });

    const { rows: outbox } = await adminPool!.query<{ event_type: string; aggregate_id: string }>(
      "SELECT event_type, aggregate_id FROM order_service.outbox_events WHERE aggregate_id = $1",
      [orderId],
    );
    expect(outbox).toEqual([{ event_type: "inventory.hold.release", aggregate_id: orderId }]);
  });

  it("keeps an attempt open when the Event hold state is uncertain", async () => {
    eventResponseStatus = 503;
    const attemptId = randomUUID();
    await adminPool!.query(
      `INSERT INTO order_service.checkout_attempts
        (id, user_id, idempotency_key, request_hash, order_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, now() - interval '2 minutes')`,
      [attemptId, randomUUID(), `key-${attemptId}`, "b".repeat(64), randomUUID()],
    );

    await expect(reconciliation()).resolves.toBe(1);

    const { rows } = await adminPool!.query<{ state: string }>(
      "SELECT state FROM order_service.checkout_attempts WHERE id = $1",
      [attemptId],
    );
    expect(rows[0]?.state).toBe("in_progress");
  });
});
