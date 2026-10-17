import amqp from "amqplib";
import {
  TicketingEventV1Schema,
  ticketingEventsDeadLetterExchangeName,
  ticketingEventsDeadLetterQueueName,
  ticketingEventsDeadLetterRoutingKey,
  ticketingEventsExchangeName,
  ticketingEventsQueueName,
  ticketingEventsRetryExchangeName,
  ticketingEventsRetryQueueName,
  ticketingEventsRetryRoutingKey,
  ticketingEventsRoutingKey,
} from "@ticket-live/contracts";
import { createLogger, env, ticketingAmqpUrl } from "@ticket-live/runtime";
import { invalidateEventTickets, issueOrderTickets } from "../services/ticketService.ts";

const logger = createLogger("ticket-live-ticketing-service");
const initialReconnectDelayMs = 1_000;
const maximumReconnectDelayMs = 30_000;

type ActiveSession = {
  connection: amqp.ChannelModel;
  consumer: amqp.Channel;
  publisher: amqp.ConfirmChannel;
};

async function assertTopology(channel: amqp.Channel): Promise<void> {
  await channel.assertExchange(ticketingEventsExchangeName, "direct", { durable: true });
  await channel.assertQueue(ticketingEventsQueueName, { durable: true });
  await channel.bindQueue(ticketingEventsQueueName, ticketingEventsExchangeName, ticketingEventsRoutingKey);

  await channel.assertExchange(ticketingEventsRetryExchangeName, "direct", { durable: true });
  await channel.assertQueue(ticketingEventsRetryQueueName, {
    durable: true,
    messageTtl: env.TICKETING_RETRY_DELAY_MS,
    deadLetterExchange: ticketingEventsExchangeName,
    deadLetterRoutingKey: ticketingEventsRoutingKey,
  });
  await channel.bindQueue(ticketingEventsRetryQueueName, ticketingEventsRetryExchangeName, ticketingEventsRetryRoutingKey);

  await channel.assertExchange(ticketingEventsDeadLetterExchangeName, "direct", { durable: true });
  await channel.assertQueue(ticketingEventsDeadLetterQueueName, { durable: true });
  await channel.bindQueue(ticketingEventsDeadLetterQueueName, ticketingEventsDeadLetterExchangeName, ticketingEventsDeadLetterRoutingKey);
}

async function publishConfirmed(
  channel: amqp.ConfirmChannel,
  exchange: string,
  routingKey: string,
  source: amqp.ConsumeMessage,
  headers: Record<string, unknown>,
  type: string,
): Promise<void> {
  const messageId = source.properties.messageId ?? "ticketing-unknown-message";
  let returned = false;
  const onReturn = (message: amqp.Message) => {
    if (message.properties.messageId === messageId) returned = true;
  };
  channel.on("return", onReturn);
  try {
    await new Promise<void>((resolve, reject) => {
      channel.publish(exchange, routingKey, source.content, {
        persistent: true,
        mandatory: true,
        contentType: source.properties.contentType ?? "application/json",
        correlationId: source.properties.correlationId ?? messageId,
        messageId,
        type,
        timestamp: Math.floor(Date.now() / 1_000),
        headers,
      }, (error) => error ? reject(error) : resolve());
    });
    await channel.waitForConfirms();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (returned) throw new Error(`RabbitMQ did not route ${type}`);
  } finally {
    channel.off("return", onReturn);
  }
}

function retryCount(message: amqp.ConsumeMessage): number {
  const value = message.properties.headers?.["x-ticketing-retry-count"];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return 0;
}

async function publishRetry(
  publisher: amqp.ConfirmChannel,
  message: amqp.ConsumeMessage,
  attempt: number,
): Promise<void> {
  await publishConfirmed(
    publisher,
    ticketingEventsRetryExchangeName,
    ticketingEventsRetryRoutingKey,
    message,
    {
      ...(message.properties.headers ?? {}),
      "x-ticketing-retry-count": attempt,
      "x-ticketing-first-failed-at": message.properties.headers?.["x-ticketing-first-failed-at"] ?? new Date().toISOString(),
    },
    "ticketing.event.v1.retry",
  );
}

async function publishDeadLetter(
  publisher: amqp.ConfirmChannel,
  message: amqp.ConsumeMessage,
  reason: string,
): Promise<void> {
  await publishConfirmed(
    publisher,
    ticketingEventsDeadLetterExchangeName,
    ticketingEventsDeadLetterRoutingKey,
    message,
    {
      ...(message.properties.headers ?? {}),
      "x-ticketing-dead-letter-reason": reason,
      "x-ticketing-dead-lettered-at": new Date().toISOString(),
    },
    "ticketing.event.v1.dead-letter",
  );
}

async function handleMessage(
  consumer: amqp.Channel,
  publisher: amqp.ConfirmChannel,
  message: amqp.ConsumeMessage,
): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(message.content.toString("utf8"));
  } catch {
    await publishDeadLetter(publisher, message, "invalid_json");
    consumer.ack(message);
    return;
  }

  const parsed = TicketingEventV1Schema.safeParse(value);
  if (!parsed.success) {
    await publishDeadLetter(publisher, message, "invalid_contract");
    consumer.ack(message);
    logger.error("Invalid message moved to Ticketing dead-letter queue", {
      messageId: message.properties.messageId,
    });
    return;
  }

  try {
    if (parsed.data.eventType === "order.confirmed") {
      await issueOrderTickets(parsed.data);
    } else {
      await invalidateEventTickets(parsed.data);
    }
    consumer.ack(message);
  } catch (error) {
    const count = retryCount(message);
    if (count >= env.TICKETING_MAX_RETRIES) {
      await publishDeadLetter(publisher, message, "retry_limit_reached");
      consumer.ack(message);
      logger.error("Ticketing message exhausted retries", {
        messageId: message.properties.messageId,
        eventType: parsed.data.eventType,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return;
    }

    await publishRetry(publisher, message, count + 1);
    consumer.ack(message);
    logger.warn("Ticketing message scheduled for retry", {
      messageId: message.properties.messageId,
      eventType: parsed.data.eventType,
      retryCount: count + 1,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export function startTicketingConsumer(): { isReady: () => boolean; stop: () => Promise<void> } {
  let stopping = false;
  let ready = false;
  let active: ActiveSession | undefined;
  let wakeReconnect: (() => void) | undefined;
  const connectLoop = async () => {
    let delay = initialReconnectDelayMs;
    while (!stopping) {
      try {
        const connection = await amqp.connect(ticketingAmqpUrl);
        const consumer = await connection.createChannel();
        const publisher = await connection.createConfirmChannel();
        active = { connection, consumer, publisher };

        if (env.RABBITMQ_AUTO_DECLARE_TOPOLOGY) await assertTopology(consumer);
        await consumer.prefetch(10);
        await consumer.consume(ticketingEventsQueueName, (message) => {
          if (!message || !active) return;
          void handleMessage(consumer, publisher, message).catch((error) => {
            logger.error("Ticketing message handling failed", {
              messageId: message.properties.messageId,
              errorType: error instanceof Error ? error.name : "UnknownError",
            });
            try { consumer.nack(message, false, true); } catch { /* The connection will redeliver on reconnect. */ }
          });
        }, { noAck: false });
        ready = true;
        delay = initialReconnectDelayMs;
        await new Promise<void>((resolve) => {
          const reconnect = () => resolve();
          connection.once("close", reconnect);
          consumer.once("close", reconnect);
          publisher.once("close", reconnect);
          connection.once("error", () => { ready = false; });
          consumer.once("error", () => { ready = false; });
          publisher.once("error", () => { ready = false; });
        });
      } catch (error) {
        logger.error("Ticketing RabbitMQ connection failed", {
          errorType: error instanceof Error ? error.name : "UnknownError",
          reconnectDelayMs: delay,
        });
      } finally {
        ready = false;
        const session = active;
        active = undefined;
        if (session) {
          await session.consumer.close().catch(() => undefined);
          await session.publisher.close().catch(() => undefined);
          await session.connection.close().catch(() => undefined);
        }
      }
      if (!stopping) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wakeReconnect = undefined;
            resolve();
          }, delay);
          wakeReconnect = () => {
            clearTimeout(timer);
            wakeReconnect = undefined;
            resolve();
          };
        });
        delay = Math.min(maximumReconnectDelayMs, delay * 2);
      }
    }
  };

  const loop = connectLoop();
  return {
    isReady: () => ready,
    stop: async () => {
      stopping = true;
      wakeReconnect?.();
      const session = active;
      if (session) await session.connection.close().catch(() => undefined);
      await loop;
    },
  };
}
