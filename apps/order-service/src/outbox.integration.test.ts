import { createConnection, createServer, type Server } from "node:net";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import amqp from "amqplib";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import {
  EmailSendV1Schema,
  emailSendExchangeName,
  emailSendQueueName,
  emailSendRoutingKey,
  ticketingEventsExchangeName,
  ticketingEventsQueueName,
  ticketingEventsRoutingKey,
  TicketingOrderConfirmedV1Schema,
} from "@ticket-live/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseName = "ticket_live_order_outbox_integration";
const orderPassword = "integration-order-outbox-password";
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
let broker: amqp.ChannelModel | undefined;
let brokerChannel: amqp.Channel | undefined;
let proxy: Server | undefined;
let proxyPort: number | undefined;
let brokerAvailable = false;
let processOutboxBatch: typeof import("./workers/outboxWorker.ts")["processOutboxBatch"];

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

async function declareRequiredTopology(channel: amqp.Channel): Promise<void> {
  await channel.assertExchange(emailSendExchangeName, "direct", { durable: true });
  await channel.assertQueue(emailSendQueueName, { durable: true });
  await channel.bindQueue(emailSendQueueName, emailSendExchangeName, emailSendRoutingKey);
  await channel.assertExchange(ticketingEventsExchangeName, "direct", { durable: true });
  await channel.assertQueue(ticketingEventsQueueName, { durable: true });
  await channel.bindQueue(
    ticketingEventsQueueName,
    ticketingEventsExchangeName,
    ticketingEventsRoutingKey,
  );
}

beforeAll(async () => {
  const brokerUrl = process.env.TEST_RABBITMQ_URL;
  if (!brokerUrl) {
    throw new Error("TEST_RABBITMQ_URL must point to an isolated RabbitMQ instance");
  }

  const target = new URL(brokerUrl);
  const tcpProxy = createServer((client) => {
    if (!brokerAvailable) {
      client.destroy();
      return;
    }

    const upstream = createConnection({
      host: target.hostname,
      port: Number(target.port || 5672),
    });
    client.pipe(upstream);
    upstream.pipe(client);
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
    upstream.on("error", () => client.destroy());
    client.on("error", () => undefined);
  });
  proxy = tcpProxy;
  await new Promise<void>((resolveListen, reject) => {
    proxy!.once("error", reject);
    proxy!.listen(0, "127.0.0.1", resolveListen);
  });
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") {
    throw new Error("RabbitMQ proxy did not bind to a TCP port");
  }
  proxyPort = proxyAddress.port;

  const orderBrokerUrl = new URL(brokerUrl);
  orderBrokerUrl.hostname = "127.0.0.1";
  orderBrokerUrl.port = String(proxyPort);
  process.env.TICKETLIVE_SERVICE = "order";
  process.env.NODE_ENV = "test";
  process.env.CORS_ORIGINS = "http://localhost:3000";
  process.env.ORDER_EVENT_TOKEN = "integration-order-event-token-1234567890";
  process.env.ORDER_PAYMENT_TOKEN = "integration-order-payment-token-1234567890";
  process.env.ORDER_AMQP_URL = orderBrokerUrl.toString();
  process.env.RABBITMQ_AUTO_DECLARE_TOPOLOGY = "false";

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
    "ALTER ROLE ticketlive_order LOGIN PASSWORD 'integration-order-outbox-password'",
  );
  await applyRepositoryMigrations(adminPool);

  const orderUrl = new URL(adminUrl);
  orderUrl.username = "ticketlive_order";
  orderUrl.password = orderPassword;
  process.env.ORDER_SERVICE_DATABASE_URL = orderUrl.toString();

  const [workerModule, databaseModule] = await Promise.all([
    import("./workers/outboxWorker.ts"),
    import("./db/client.ts"),
  ]);
  processOutboxBatch = workerModule.processOutboxBatch;
  orderPool = databaseModule.pool;

  broker = await amqp.connect(brokerUrl);
  brokerChannel = await broker.createChannel();
  await declareRequiredTopology(brokerChannel);
  for (const queue of [emailSendQueueName, ticketingEventsQueueName]) {
    await brokerChannel.purgeQueue(queue);
  }
}, 120_000);

afterAll(async () => {
  try {
    await brokerChannel?.close();
    await broker?.close();
  } finally {
    try {
      await orderPool?.end();
    } finally {
      try {
        await adminPool?.end();
      } finally {
        try {
          await container?.stop();
        } finally {
          await new Promise<void>((resolveClose, reject) => {
            if (!proxy?.listening) return resolveClose();
            proxy.close((error) => error ? reject(error) : resolveClose());
          });
        }
      }
    }
  }
});

describe("Order outbox integration", () => {
  it("keeps events pending during a RabbitMQ outage and publishes them after recovery", async () => {
    const orderId = randomUUID();
    const outboxEventId = randomUUID();
    const eventId = randomUUID();
    await adminPool!.query(
      `INSERT INTO order_service.outbox_events (id, event_type, aggregate_id, payload)
       VALUES ($1, 'order.confirmed', $2, $3::jsonb)`,
      [outboxEventId, orderId, JSON.stringify({
        orderId,
        customer: { name: "Integration Customer", email: "customer@example.test" },
        event: {
          id: eventId,
          name: "Integration Event",
          location: "Berlin",
          startsAt: "2030-01-01T18:00:00.000Z",
        },
        quantity: 2,
        ticketPriceCents: 3_200,
        totalAmountCents: 6_400,
        currencyCode: "EUR",
      })],
    );

    brokerAvailable = false;
    await expect(processOutboxBatch()).resolves.toBe(1);
    const { rows: failedRows } = await adminPool!.query<{
      attempts: number;
      processed_at: Date | null;
      last_error: string | null;
    }>(
      "SELECT attempts, processed_at, last_error FROM order_service.outbox_events WHERE id = $1",
      [outboxEventId],
    );
    expect(failedRows[0]?.attempts).toBe(1);
    expect(failedRows[0]?.processed_at).toBeNull();
    expect(failedRows[0]?.last_error).toBeTruthy();

    await declareRequiredTopology(brokerChannel!);
    brokerAvailable = true;
    await adminPool!.query(
      "UPDATE order_service.outbox_events SET available_at = now() WHERE id = $1",
      [outboxEventId],
    );
    await expect(processOutboxBatch()).resolves.toBe(1);

    const { rows: processedRows } = await adminPool!.query<{
      attempts: number;
      processed_at: Date | null;
    }>(
      "SELECT attempts, processed_at FROM order_service.outbox_events WHERE id = $1",
      [outboxEventId],
    );
    expect(processedRows[0]?.attempts).toBe(1);
    expect(processedRows[0]?.processed_at).toBeInstanceOf(Date);

    const emailMessage = await brokerChannel!.get(emailSendQueueName, { noAck: false });
    expect(emailMessage).not.toBe(false);
    if (emailMessage === false) throw new Error("Order outbox did not publish an Email command");
    const email = EmailSendV1Schema.parse(JSON.parse(emailMessage.content.toString("utf8")));
    expect(email).toMatchObject({
      commandId: outboxEventId,
      commandType: "email.send",
      notificationKey: `order-confirmation:${orderId}`,
      recipient: "customer@example.test",
      data: { orderId, totalAmountCents: 6_400 },
    });
    brokerChannel!.ack(emailMessage);

    const ticketingMessage = await brokerChannel!.get(ticketingEventsQueueName, { noAck: false });
    expect(ticketingMessage).not.toBe(false);
    if (ticketingMessage === false) throw new Error("Order outbox did not publish a Ticketing event");
    const ticketing = TicketingOrderConfirmedV1Schema.parse(
      JSON.parse(ticketingMessage.content.toString("utf8")),
    );
    expect(ticketing).toMatchObject({
      eventId: outboxEventId,
      eventType: "order.confirmed",
      aggregateId: orderId,
      data: { orderId, event: { id: eventId }, quantity: 2 },
    });
    brokerChannel!.ack(ticketingMessage);
  });
});
