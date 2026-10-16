import amqp from "amqplib";
import {
  EmailSendV1Schema,
  emailSendDeadLetterExchangeName,
  emailSendDeadLetterQueueName,
  emailSendDeadLetterRoutingKey,
  emailSendExchangeName,
  emailSendQueueName,
  emailSendRetryExchangeName,
  emailSendRetryQueueName,
  emailSendRetryRoutingKey,
  emailSendRoutingKey,
  orderConfirmationQueueName,
  parseOrderConfirmedMessage,
  type EmailSendV1,
} from "@ticket-live/contracts";
import { randomUUID } from "node:crypto";
import { emailAmqpUrl, env } from "@ticket-live/runtime";
import { createLogger } from "@ticket-live/runtime";
import {
  createMessageTraceContext,
  runWithTraceContext,
} from "@ticket-live/runtime";
import { startSpan } from "@ticket-live/runtime";
import {
  claimDeliveryIntent,
  recordDeliveryFailure,
  recordProviderAcceptance,
  recordUnknownProviderOutcome,
  scheduleDeliveryRetry,
} from "./deliveryStore.ts";
import { EmailProviderError, getEmailProvider, type EmailProvider } from "./provider.ts";

const logger = createLogger("ticket-live-email-service");
const reconnectInitialDelayMs = 1_000;
const reconnectMaxDelayMs = 30_000;

type ActiveSession = {
  connection: amqp.ChannelModel;
  consumerChannel: amqp.Channel;
  publisherChannel: amqp.ConfirmChannel;
};

type ConsumerHandle = {
  isReady: () => boolean;
  stop: () => Promise<void>;
};

function headerNumber(message: amqp.ConsumeMessage, name: string): number {
  const value = message.properties.headers?.[name];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return 0;
}

function parseEmailCommand(value: unknown): EmailSendV1 {
  const current = EmailSendV1Schema.safeParse(value);
  if (current.success) return current.data;

  const legacy = parseOrderConfirmedMessage(value);
  return EmailSendV1Schema.parse({
    commandId: legacy.eventId,
    commandType: "email.send",
    schemaVersion: 1,
    notificationKey: `order-confirmation:${legacy.data.orderId}`,
    templateId: "order-confirmation-v1",
    recipient: legacy.data.customer.email,
    data: {
      orderId: legacy.data.orderId,
      customerName: legacy.data.customer.name,
      eventName: legacy.data.event.name,
      eventLocation: legacy.data.event.location,
      eventStartsAt: legacy.data.event.startsAt,
      quantity: legacy.data.quantity,
      totalAmountCents: legacy.data.totalAmountCents,
      currencyCode: legacy.data.currencyCode,
    },
  });
}

async function assertEmailTopology(
  channel: amqp.Channel,
  includeLegacyQueue: boolean,
): Promise<void> {
  await channel.assertExchange(emailSendExchangeName, "direct", { durable: true });
  await channel.assertQueue(emailSendQueueName, { durable: true });
  await channel.bindQueue(emailSendQueueName, emailSendExchangeName, emailSendRoutingKey);

  await channel.assertExchange(emailSendRetryExchangeName, "direct", { durable: true });
  await channel.assertQueue(emailSendRetryQueueName, {
    durable: true,
    messageTtl: env.EMAIL_RETRY_DELAY_MS,
    deadLetterExchange: emailSendExchangeName,
    deadLetterRoutingKey: emailSendRoutingKey,
  });
  await channel.bindQueue(emailSendRetryQueueName, emailSendRetryExchangeName, emailSendRetryRoutingKey);

  await channel.assertExchange(emailSendDeadLetterExchangeName, "direct", { durable: true });
  await channel.assertQueue(emailSendDeadLetterQueueName, { durable: true });
  await channel.bindQueue(emailSendDeadLetterQueueName, emailSendDeadLetterExchangeName, emailSendDeadLetterRoutingKey);

  if (includeLegacyQueue) {
    await channel.assertQueue(orderConfirmationQueueName, { durable: true });
  }
}

async function publishConfirmed(
  channel: amqp.ConfirmChannel,
  exchange: string,
  routingKey: string,
  content: Buffer,
  properties: amqp.Options.Publish,
): Promise<void> {
  const messageId = properties.messageId ?? randomUUID();
  let returned = false;
  const onReturn = (message: amqp.Message) => {
    if (message.properties.messageId === messageId) returned = true;
  };
  channel.on("return", onReturn);

  try {
    await new Promise<void>((resolve, reject) => {
      channel.publish(exchange, routingKey, content, {
        ...properties,
        messageId,
        mandatory: true,
      }, (error) => error ? reject(error) : resolve());
    });
    await channel.waitForConfirms();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (returned) throw new Error("RabbitMQ did not route the Email message");
  } finally {
    channel.off("return", onReturn);
  }
}

function baseHeaders(message: amqp.ConsumeMessage): Record<string, unknown> {
  return { ...(message.properties.headers ?? {}) };
}

async function publishRetry(
  publisher: amqp.ConfirmChannel,
  message: EmailSendV1,
  source: amqp.ConsumeMessage,
  retryCount: number,
): Promise<void> {
  const headers = baseHeaders(source);
  headers["x-email-retry-count"] = retryCount;
  headers["x-email-first-failed-at"] ??= new Date().toISOString();
  await publishConfirmed(
    publisher,
    emailSendRetryExchangeName,
    emailSendRetryRoutingKey,
    Buffer.from(JSON.stringify(message)),
    {
      contentType: "application/json",
      correlationId: source.properties.correlationId ?? message.commandId,
      messageId: message.commandId,
      type: "email.send.v1",
      timestamp: Math.floor(Date.now() / 1_000),
      headers,
      persistent: true,
    },
  );
}

async function publishDeadLetter(
  publisher: amqp.ConfirmChannel,
  content: Buffer,
  message: amqp.ConsumeMessage,
  reason: string,
  normalized?: EmailSendV1,
): Promise<void> {
  const headers = baseHeaders(message);
  headers["x-email-dead-letter-reason"] = reason;
  headers["x-email-first-failed-at"] ??= new Date().toISOString();
  headers["x-email-dead-lettered-at"] = new Date().toISOString();
  await publishConfirmed(
    publisher,
    emailSendDeadLetterExchangeName,
    emailSendDeadLetterRoutingKey,
    normalized ? Buffer.from(JSON.stringify(normalized)) : content,
    {
      contentType: normalized ? "application/json" : message.properties.contentType,
      correlationId: message.properties.correlationId ?? message.properties.messageId ?? randomUUID(),
      messageId: message.properties.messageId ?? normalized?.commandId ?? randomUUID(),
      type: "email.send.v1.dead-letter",
      timestamp: Math.floor(Date.now() / 1_000),
      headers,
      persistent: true,
    },
  );
}

function errorCode(error: unknown): string {
  if (error instanceof EmailProviderError) return error.code;
  return error instanceof Error ? error.name : "UnknownError";
}

async function acknowledgeUnknownOutcome(
  channel: amqp.Channel,
  publisher: amqp.ConfirmChannel,
  message: amqp.ConsumeMessage,
  command: EmailSendV1,
  provider: EmailProvider,
  error: unknown,
): Promise<boolean> {
  if (!(error instanceof EmailProviderError) || error.outcome !== "unknown") return false;

  let accepted;
  try {
    accepted = await provider.findByIdempotencyKey(command.notificationKey);
  } catch {
    // If lookup is unavailable, retain the unknown outcome and let bounded retries retry the lookup.
  }
  if (accepted) {
    await recordProviderAcceptance(command.notificationKey, accepted);
    channel.ack(message);
    return true;
  }

  if (provider.supportsIdempotencyKeys) return false;

  await publishDeadLetter(publisher, message.content, message, "unknown_provider_outcome", command);
  await recordUnknownProviderOutcome(command.notificationKey, provider.name, "unknown_provider_outcome");
  logger.error("Email outcome is unknown; message moved to the dead-letter queue for reconciliation", {
    commandId: command.commandId,
    notificationKey: command.notificationKey,
    orderId: command.data.orderId,
    providerName: provider.name,
  });
  channel.ack(message);
  return true;
}

async function handleProcessingFailure(
  channel: amqp.Channel,
  publisher: amqp.ConfirmChannel,
  message: amqp.ConsumeMessage,
  command: EmailSendV1,
  provider: EmailProvider,
  error: unknown,
): Promise<void> {
  if (await acknowledgeUnknownOutcome(channel, publisher, message, command, provider, error)) return;

  const code = errorCode(error);
  const permanent = error instanceof EmailProviderError && error.outcome === "permanent";
  const retryCount = headerNumber(message, "x-email-retry-count");

  if (!permanent && retryCount < env.EMAIL_MAX_RETRIES) {
    const nextRetryCount = retryCount + 1;
    // Start the durable due time before publishing to the TTL queue so the
    // returned message cannot beat the database timestamp by a few ms.
    await scheduleDeliveryRetry(
      command.notificationKey,
      new Date(Date.now() + env.EMAIL_RETRY_DELAY_MS),
      code,
    ).catch(() => undefined);
    await publishRetry(publisher, command, message, nextRetryCount);
    logger.warn("Email command scheduled for delayed retry", {
      commandId: command.commandId,
      notificationKey: command.notificationKey,
      orderId: command.data.orderId,
      retryCount: nextRetryCount,
      errorType: code,
    });
    channel.ack(message);
    return;
  }

  await publishDeadLetter(publisher, message.content, message, code, command);
  await recordDeliveryFailure(command.notificationKey, provider.name, code);
  logger.error("Email command exhausted retries or failed permanently; moved to dead-letter queue", {
    commandId: command.commandId,
    notificationKey: command.notificationKey,
    orderId: command.data.orderId,
    retryCount,
    errorType: code,
  });
  channel.ack(message);
}

async function consumeMessage(
  consumer: amqp.Channel,
  publisher: amqp.ConfirmChannel,
  queueName: string,
  message: amqp.ConsumeMessage,
): Promise<void> {
  const traceValue = (name: string) => message.properties.headers?.[name];
  const context = createMessageTraceContext({
    correlationId: message.properties.correlationId ?? message.properties.messageId,
    traceparent: typeof traceValue("traceparent") === "string" ? traceValue("traceparent") as string : undefined,
    tracestate: typeof traceValue("tracestate") === "string" ? traceValue("tracestate") as string : undefined,
  });

  await runWithTraceContext(context, async () => {
    const finishSpan = startSpan(context, "rabbitmq.consume", {
      "messaging.system": "rabbitmq",
      "messaging.destination.name": queueName,
      ...(message.properties.messageId ? { "messaging.message.id": message.properties.messageId } : {}),
    }, "ticket-live-email-service", 5);

    let command: EmailSendV1;
    try {
      command = parseEmailCommand(JSON.parse(message.content.toString()));
    } catch {
      await publishDeadLetter(publisher, message.content, message, "invalid_email_command");
      logger.error("Invalid Email command moved to dead-letter queue", {
        messageId: message.properties.messageId,
        queueName,
      });
      finishSpan("error");
      consumer.ack(message);
      return;
    }

    const provider = getEmailProvider();
    try {
      const claim = await claimDeliveryIntent(
        command,
        provider.name,
        message.properties.headers?.["x-email-replay"] === true ||
          message.properties.headers?.["x-email-replay"] === "true",
      );
      if (claim.kind === "terminal") {
        logger.info("Duplicate Email command skipped", {
          commandId: command.commandId,
          notificationKey: command.notificationKey,
          orderId: command.data.orderId,
        });
        finishSpan("ok", { "order.id": command.data.orderId });
        consumer.ack(message);
        return;
      }
      if (claim.kind === "not_due") {
        // Keep a message that arrived before its durable due time instead of
        // acknowledging and losing the only retry command.
        await publishRetry(
          publisher,
          command,
          message,
          headerNumber(message, "x-email-retry-count"),
        );
        consumer.ack(message);
        finishSpan("ok", { "email.retry.not_due": true });
        return;
      }
      if (claim.kind === "conflict") {
        await publishDeadLetter(publisher, message.content, message, "notification_key_conflict", command);
        logger.error("Email notification key was reused for different delivery data", {
          commandId: command.commandId,
          notificationKey: command.notificationKey,
        });
        finishSpan("error", { "order.id": command.data.orderId });
        consumer.ack(message);
        return;
      }

      if (claim.wasSending) {
        const priorAcceptance = await provider.findByIdempotencyKey(command.notificationKey);
        if (priorAcceptance) {
          await recordProviderAcceptance(command.notificationKey, priorAcceptance);
          finishSpan("ok", { "order.id": command.data.orderId });
          consumer.ack(message);
          return;
        }
        if (!provider.supportsIdempotencyKeys) {
          await handleProcessingFailure(
            consumer,
            publisher,
            message,
            command,
            provider,
            new EmailProviderError("Prior provider outcome could not be reconciled", "unknown_provider_outcome", "unknown"),
          );
          finishSpan("error", { "order.id": command.data.orderId });
          return;
        }
      }

      const acceptance = await provider.send({
        message: command,
        idempotencyKey: command.notificationKey,
      });
      await recordProviderAcceptance(command.notificationKey, acceptance);
      logger.info("Email accepted by provider adapter", {
        commandId: command.commandId,
        notificationKey: command.notificationKey,
        orderId: command.data.orderId,
        providerName: acceptance.providerName,
        providerMessageId: acceptance.providerMessageId,
      });
      finishSpan("ok", { "order.id": command.data.orderId });
      consumer.ack(message);
    } catch (error) {
      finishSpan("error", { "order.id": command.data.orderId });
      await handleProcessingFailure(consumer, publisher, message, command, provider, error);
    }
  });
}

async function openSession(): Promise<ActiveSession> {
  const connection = await amqp.connect(emailAmqpUrl);
  try {
    const consumerChannel = await connection.createChannel();
    const publisherChannel = await connection.createConfirmChannel();
    if (env.RABBITMQ_AUTO_DECLARE_TOPOLOGY) {
      await assertEmailTopology(consumerChannel, env.EMAIL_LEGACY_QUEUE_ENABLED);
    }
    await consumerChannel.prefetch(1);
    await consumerChannel.consume(emailSendQueueName, (message) => {
      if (message) void consumeMessage(consumerChannel, publisherChannel, emailSendQueueName, message)
        .catch((error) => {
          logger.error("Email command processing failed before acknowledgement", {
            errorType: error instanceof Error ? error.name : "UnknownError",
          });
          consumerChannel.nack(message, false, true);
        });
    });
    if (env.EMAIL_LEGACY_QUEUE_ENABLED) {
      await consumerChannel.consume(orderConfirmationQueueName, (message) => {
        if (message) void consumeMessage(consumerChannel, publisherChannel, orderConfirmationQueueName, message)
          .catch((error) => {
            logger.error("Legacy Email command processing failed before acknowledgement", {
              errorType: error instanceof Error ? error.name : "UnknownError",
            });
            consumerChannel.nack(message, false, true);
          });
      });
    }
    return { connection, consumerChannel, publisherChannel };
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}

export function startEmailWorker(): ConsumerHandle {
  let ready = false;
  let stopRequested = false;
  let currentConnection: amqp.ChannelModel | undefined;
  let reconnectDelayMs = reconnectInitialDelayMs;

  const run = async () => {
    while (!stopRequested) {
      let session: ActiveSession | undefined;
      try {
        session = await openSession();
        currentConnection = session.connection;
        reconnectDelayMs = reconnectInitialDelayMs;
        if (stopRequested) {
          await session.connection.close().catch(() => undefined);
          currentConnection = undefined;
          break;
        }
        ready = true;
        logger.info("Email RabbitMQ consumer ready", {
          queueName: emailSendQueueName,
          legacyQueueEnabled: env.EMAIL_LEGACY_QUEUE_ENABLED,
        });

        await new Promise<void>((resolve) => {
          session?.connection.once("close", resolve);
          session?.connection.once("error", (error) => {
            logger.error("Email RabbitMQ connection failed", {
              errorType: error instanceof Error ? error.name : "UnknownError",
            });
          });
        });
        ready = false;
        currentConnection = undefined;
        if (!stopRequested) logger.error("Email RabbitMQ connection closed; reconnecting");
      } catch (error) {
        ready = false;
        currentConnection = undefined;
        logger.error("Email RabbitMQ connection attempt failed", {
          errorType: error instanceof Error ? error.name : "UnknownError",
          reconnectDelayMs,
        });
        if (session) await session.connection.close().catch(() => undefined);
      }

      if (stopRequested) break;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
      reconnectDelayMs = Math.min(reconnectMaxDelayMs, reconnectDelayMs * 2);
    }
  };

  const runPromise = run();
  return {
    isReady: () => ready,
    stop: async () => {
      stopRequested = true;
      ready = false;
      await currentConnection?.close().catch(() => undefined);
      await runPromise;
    },
  };
}
