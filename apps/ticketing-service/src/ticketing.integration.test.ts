import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import amqp from "amqplib";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import {
  ticketingEventsDeadLetterExchangeName,
  ticketingEventsDeadLetterQueueName,
  ticketingEventsDeadLetterRoutingKey,
  ticketingEventsExchangeName,
  ticketingEventsQueueName,
  ticketingEventsRoutingKey,
  ticketingEventsRetryExchangeName,
  ticketingEventsRetryRoutingKey,
  ticketingEventsRetryQueueName,
} from "@ticket-live/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseName = "ticket_live_ticketing_integration";
const ticketingPassword = "integration-ticketing-password";
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
let ticketingPool: Pool | undefined;
let broker: amqp.ChannelModel | undefined;
let publisher: amqp.ConfirmChannel | undefined;
let queueReader: amqp.Channel | undefined;
let stopConsumer: (() => Promise<void>) | undefined;

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

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("Condition was not met before the integration test timeout");
}

async function waitForQueueMessage(channel: amqp.Channel, queue: string): Promise<amqp.GetMessage> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const message = await channel.get(queue, { noAck: false });
    if (message) return message;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`No message arrived in ${queue} before the integration timeout`);
}

async function publish(content: Buffer, messageId: string): Promise<void> {
  publisher!.publish(ticketingEventsExchangeName, ticketingEventsRoutingKey, content, {
    contentType: "application/json",
    persistent: true,
    messageId,
  });
  await publisher!.waitForConfirms();
}

async function prepareTicketingTopology(channel: amqp.Channel): Promise<void> {
  await channel.assertExchange(ticketingEventsExchangeName, "direct", { durable: true });
  await channel.assertQueue(ticketingEventsQueueName, { durable: true });
  await channel.bindQueue(
    ticketingEventsQueueName,
    ticketingEventsExchangeName,
    ticketingEventsRoutingKey,
  );

  await channel.assertExchange(ticketingEventsRetryExchangeName, "direct", { durable: true });
  await channel.assertQueue(ticketingEventsRetryQueueName, {
    durable: true,
    messageTtl: 1_000,
    deadLetterExchange: ticketingEventsExchangeName,
    deadLetterRoutingKey: ticketingEventsRoutingKey,
  });
  await channel.bindQueue(
    ticketingEventsRetryQueueName,
    ticketingEventsRetryExchangeName,
    ticketingEventsRetryRoutingKey,
  );

  await channel.assertExchange(ticketingEventsDeadLetterExchangeName, "direct", { durable: true });
  await channel.assertQueue(ticketingEventsDeadLetterQueueName, { durable: true });
  await channel.bindQueue(
    ticketingEventsDeadLetterQueueName,
    ticketingEventsDeadLetterExchangeName,
    ticketingEventsDeadLetterRoutingKey,
  );

  for (const queue of [
    ticketingEventsQueueName,
    ticketingEventsRetryQueueName,
    ticketingEventsDeadLetterQueueName,
  ]) {
    await channel.purgeQueue(queue);
  }
}

function orderConfirmed(eventId: string, orderId: string, ticketEventId: string) {
  return {
    eventId,
    eventType: "order.confirmed",
    schemaVersion: 1,
    aggregateId: orderId,
    occurredAt: "2029-12-01T10:00:00.000Z",
    correlationId: randomUUID(),
    data: {
      orderId,
      customer: { name: "Integration Customer" },
      event: {
        id: ticketEventId,
        name: "Integration Event",
        location: "Berlin",
        startsAt: "2030-01-01T18:00:00.000Z",
      },
      quantity: 2,
    },
  };
}

beforeAll(async () => {
  process.env.TICKETLIVE_SERVICE = "ticketing";
  process.env.NODE_ENV = "test";
  process.env.CORS_ORIGINS = "http://localhost:3000";
  process.env.TICKETING_RETRY_DELAY_MS = "1000";
  process.env.TICKETING_MAX_RETRIES = "1";
  process.env.TICKETING_AMQP_URL = process.env.TEST_RABBITMQ_URL ?? "";
  if (!process.env.TICKETING_AMQP_URL) {
    throw new Error("TEST_RABBITMQ_URL must point to an isolated RabbitMQ instance");
  }

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
    "ALTER ROLE ticketlive_ticketing LOGIN PASSWORD 'integration-ticketing-password'",
  );
  await applyRepositoryMigrations(adminPool);

  const ticketingUrl = new URL(adminUrl);
  ticketingUrl.username = "ticketlive_ticketing";
  ticketingUrl.password = ticketingPassword;
  process.env.TICKETING_SERVICE_DATABASE_URL = ticketingUrl.toString();

  broker = await amqp.connect(process.env.TICKETING_AMQP_URL);
  publisher = await broker.createConfirmChannel();
  queueReader = await broker.createChannel();
  await prepareTicketingTopology(publisher);

  ticketingPool = (await import("./db/client.ts")).pool;
  const { startTicketingConsumer } = await import("./messaging/ticketingConsumer.ts");
  const consumer = startTicketingConsumer();
  stopConsumer = consumer.stop;
  await waitUntil(async () => consumer.isReady());
}, 120_000);

afterAll(async () => {
  try {
    await stopConsumer?.();
  } finally {
    try {
      await publisher?.close();
      await queueReader?.close();
      await broker?.close();
    } finally {
      try {
        await ticketingPool?.end();
      } finally {
        try {
          await adminPool?.end();
        } finally {
          await container?.stop();
        }
      }
    }
  }
});

describe("Ticketing consumer integration", () => {
  it("issues tickets idempotently, applies event cancellation, retries and dead-letters", async () => {
    const orderId = randomUUID();
    const eventId = randomUUID();
    const confirmation = orderConfirmed(randomUUID(), orderId, eventId);
    await publish(Buffer.from(JSON.stringify(confirmation)), confirmation.eventId);
    await waitUntil(async () => {
      const { rows } = await adminPool!.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ticketing_service.tickets WHERE order_id = $1",
        [orderId],
      );
      return rows[0]?.count === "2";
    });

    await publish(Buffer.from(JSON.stringify(confirmation)), confirmation.eventId);
    const cancellation = {
      eventId: randomUUID(),
      eventType: "event.cancelled",
      schemaVersion: 1,
      aggregateId: eventId,
      occurredAt: "2029-12-02T10:00:00.000Z",
      correlationId: randomUUID(),
      data: { eventId, version: 2 },
    };
    await publish(Buffer.from(JSON.stringify(cancellation)), cancellation.eventId);
    await waitUntil(async () => {
      const { rows } = await adminPool!.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ticketing_service.tickets WHERE order_id = $1 AND status = 'cancelled'",
        [orderId],
      );
      return rows[0]?.count === "2";
    });

    await publish(Buffer.from("{"), randomUUID());
    const invalidMessage = await waitForQueueMessage(queueReader!, ticketingEventsDeadLetterQueueName);
    expect(invalidMessage.properties.headers?.["x-ticketing-dead-letter-reason"])
      .toBe("invalid_json");
    queueReader!.ack(invalidMessage);

    const retryOrderId = randomUUID();
    const retryMessage = orderConfirmed(randomUUID(), retryOrderId, randomUUID());
    await adminPool!.query("ALTER ROLE ticketlive_ticketing NOLOGIN");
    await adminPool!.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'ticketlive_ticketing'",
    );
    await publish(Buffer.from(JSON.stringify(retryMessage)), retryMessage.eventId);
    await waitUntil(async () =>
      (await publisher!.checkQueue(ticketingEventsRetryQueueName)).messageCount > 0,
    );
    const retryDeadLetter = await waitForQueueMessage(queueReader!, ticketingEventsDeadLetterQueueName);
    expect(retryDeadLetter.properties.headers?.["x-ticketing-dead-letter-reason"])
      .toBe("retry_limit_reached");
    queueReader!.ack(retryDeadLetter);
    await adminPool!.query(
      "ALTER ROLE ticketlive_ticketing LOGIN PASSWORD 'integration-ticketing-password'",
    );
  });
});
