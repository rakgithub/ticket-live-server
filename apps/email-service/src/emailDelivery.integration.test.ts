import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import amqp from "amqplib";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import {
  emailSendDeadLetterExchangeName,
  emailSendDeadLetterQueueName,
  emailSendDeadLetterRoutingKey,
  emailSendExchangeName,
  emailSendQueueName,
  emailSendRoutingKey,
  emailSendRetryExchangeName,
  emailSendRetryRoutingKey,
  emailSendRetryQueueName,
  type EmailSendV1,
} from "@ticket-live/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseName = "ticket_live_email_integration";
const emailPassword = "integration-email-password";
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
let emailPool: Pool | undefined;
let broker: amqp.ChannelModel | undefined;
let publisher: amqp.ConfirmChannel | undefined;
let deadLetterReader: amqp.Channel | undefined;
let stopWorker: (() => Promise<void>) | undefined;

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
  publisher!.publish(emailSendExchangeName, emailSendRoutingKey, content, {
    contentType: "application/json",
    persistent: true,
    messageId,
  });
  await publisher!.waitForConfirms();
}

async function prepareEmailTopology(channel: amqp.Channel): Promise<void> {
  await channel.assertExchange(emailSendExchangeName, "direct", { durable: true });
  await channel.assertQueue(emailSendQueueName, { durable: true });
  await channel.bindQueue(emailSendQueueName, emailSendExchangeName, emailSendRoutingKey);

  await channel.assertExchange(emailSendRetryExchangeName, "direct", { durable: true });
  await channel.assertQueue(emailSendRetryQueueName, {
    durable: true,
    messageTtl: 1_000,
    deadLetterExchange: emailSendExchangeName,
    deadLetterRoutingKey: emailSendRoutingKey,
  });
  await channel.bindQueue(
    emailSendRetryQueueName,
    emailSendRetryExchangeName,
    emailSendRetryRoutingKey,
  );

  await channel.assertExchange(emailSendDeadLetterExchangeName, "direct", { durable: true });
  await channel.assertQueue(emailSendDeadLetterQueueName, { durable: true });
  await channel.bindQueue(
    emailSendDeadLetterQueueName,
    emailSendDeadLetterExchangeName,
    emailSendDeadLetterRoutingKey,
  );

  for (const queue of [emailSendQueueName, emailSendRetryQueueName, emailSendDeadLetterQueueName]) {
    await channel.purgeQueue(queue);
  }
}

function emailCommand(): EmailSendV1 {
  return {
    commandId: randomUUID(),
    commandType: "email.send",
    schemaVersion: 1,
    notificationKey: `integration:${randomUUID()}`,
    templateId: "order-confirmation-v1",
    recipient: "customer@example.test",
    data: {
      orderId: randomUUID(),
      customerName: "Integration Customer",
      eventName: "Integration Event",
      eventLocation: "Berlin",
      eventStartsAt: "2030-01-01T18:00:00.000Z",
      quantity: 1,
      totalAmountCents: 6_400,
      currencyCode: "EUR",
    },
  };
}

beforeAll(async () => {
  process.env.TICKETLIVE_SERVICE = "email";
  process.env.NODE_ENV = "test";
  process.env.CORS_ORIGINS = "http://localhost:3000";
  process.env.EMAIL_PROVIDER = "fake";
  process.env.EMAIL_LEGACY_QUEUE_ENABLED = "false";
  process.env.EMAIL_RETRY_DELAY_MS = "1000";
  process.env.EMAIL_AMQP_URL = process.env.TEST_RABBITMQ_URL ?? "";
  if (!process.env.EMAIL_AMQP_URL) {
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
    "ALTER ROLE ticketlive_email LOGIN PASSWORD 'integration-email-password'",
  );
  await applyRepositoryMigrations(adminPool);

  const emailUrl = new URL(adminUrl);
  emailUrl.username = "ticketlive_email";
  emailUrl.password = emailPassword;
  process.env.EMAIL_SERVICE_DATABASE_URL = emailUrl.toString();

  broker = await amqp.connect(process.env.EMAIL_AMQP_URL);
  publisher = await broker.createConfirmChannel();
  deadLetterReader = await broker.createChannel();
  await prepareEmailTopology(publisher);

  emailPool = (await import("./db/client.ts")).pool;
  const { startEmailWorker } = await import("./emailWorker.ts");
  const consumer = startEmailWorker();
  stopWorker = consumer.stop;
  await waitUntil(async () => consumer.isReady());
}, 120_000);

afterAll(async () => {
  try {
    await stopWorker?.();
  } finally {
    try {
      await publisher?.close();
      await deadLetterReader?.close();
      await broker?.close();
    } finally {
      try {
        await emailPool?.end();
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

describe("Email delivery integration", () => {
  it("records one delivery for duplicate commands and dead-letters malformed messages", async () => {
    const command = emailCommand();
    const bytes = Buffer.from(JSON.stringify(command));
    await publish(bytes, command.commandId);
    await waitUntil(async () => {
      const { rows } = await adminPool!.query<{ status: string }>(
        "SELECT status FROM email_service.email_deliveries WHERE notification_key = $1",
        [command.notificationKey],
      );
      return rows[0]?.status === "accepted_by_provider";
    });

    await publish(bytes, command.commandId);
    const nextCommand = emailCommand();
    await publish(Buffer.from(JSON.stringify(nextCommand)), nextCommand.commandId);
    await waitUntil(async () => {
      const { rows } = await adminPool!.query<{ status: string }>(
        "SELECT status FROM email_service.email_deliveries WHERE notification_key = $1",
        [nextCommand.notificationKey],
      );
      return rows[0]?.status === "accepted_by_provider";
    });

    const { rows: duplicates } = await adminPool!.query<{ count: string; attempts: number }>(
      `SELECT count(*)::text AS count, max(attempts) AS attempts
       FROM email_service.email_deliveries WHERE notification_key = $1`,
      [command.notificationKey],
    );
    expect(duplicates[0]).toEqual({ count: "1", attempts: 1 });

    await publish(Buffer.from("{"), randomUUID());
    const deadLetter = await waitForQueueMessage(deadLetterReader!, emailSendDeadLetterQueueName);
    expect(deadLetter.properties.headers?.["x-email-dead-letter-reason"])
      .toBe("invalid_email_command");
    deadLetterReader!.ack(deadLetter);
  });

  it("routes transient database failures through the delayed retry queue", async () => {
    const command = emailCommand();
    await adminPool!.query("ALTER ROLE ticketlive_email NOLOGIN");
    await adminPool!.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'ticketlive_email'",
    );
    await publish(Buffer.from(JSON.stringify(command)), command.commandId);
    await waitUntil(async () =>
      (await publisher!.checkQueue(emailSendRetryQueueName)).messageCount > 0,
    );

    await adminPool!.query(
      "ALTER ROLE ticketlive_email LOGIN PASSWORD 'integration-email-password'",
    );
    await waitUntil(async () => {
      const { rows } = await adminPool!.query<{ status: string; attempts: number }>(
        "SELECT status, attempts FROM email_service.email_deliveries WHERE notification_key = $1",
        [command.notificationKey],
      );
      return rows[0]?.status === "accepted_by_provider";
    }, 15_000);
  });
});
