import amqp from "amqplib";
import { EmailSendV1Schema, parseOrderConfirmedMessage, type EmailSendV1 } from "@ticket-live/contracts";
import { env } from "../config/env.ts";
import { db } from "../db/client.ts";
import { emailDeliveriesTable } from "../db/schema/emailDeliveries.ts";
import { emailSendExchangeName, emailSendQueueName, orderConfirmationQueueName } from "../messaging/publishOrderConfirmation.ts";
import { createLogger } from "../observability/logger.ts";
import { createMessageTraceContext, runWithTraceContext } from "../observability/traceContext.ts";
import { startSpan } from "../observability/traceExporter.ts";

const logger = createLogger("ticket-live-email-worker");

async function recordSimulatedDelivery(message: EmailSendV1): Promise<boolean> {
  const [delivery] = await db.insert(emailDeliveriesTable).values({
    eventId: message.commandId,
    notificationKey: message.notificationKey,
    orderId: message.data.orderId,
    recipientEmail: message.recipient,
    status: "simulated",
  }).onConflictDoNothing({ target: emailDeliveriesTable.notificationKey }).returning({ id: emailDeliveriesTable.id });
  return Boolean(delivery);
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

async function assertQueues(channel: amqp.Channel): Promise<void> {
  await channel.assertQueue(orderConfirmationQueueName, { durable: true });
  await channel.assertExchange(emailSendExchangeName, "direct", { durable: true });
  await channel.assertQueue(emailSendQueueName, { durable: true });
  await channel.bindQueue(emailSendQueueName, emailSendExchangeName, emailSendQueueName);
}

export async function startEmailWorker(): Promise<() => Promise<void>> {
  const connection = await amqp.connect(env.AMQP_URL);
  const channel = await connection.createChannel();
  await assertQueues(channel);
  await channel.prefetch(1);

  const consume = async (queueName: string, message: amqp.ConsumeMessage | null) => {
    if (!message) return;
    const headerValue = (name: string): string | undefined => {
      const value = message.properties.headers?.[name];
      return typeof value === "string" ? value : undefined;
    };
    const context = createMessageTraceContext({
      correlationId: message.properties.correlationId ?? message.properties.messageId,
      traceparent: headerValue("traceparent"),
      tracestate: headerValue("tracestate"),
    });
    await runWithTraceContext(context, async () => {
      const finishSpan = startSpan(context, "rabbitmq.consume", {
        "messaging.system": "rabbitmq",
        "messaging.destination.name": queueName,
        ...(message.properties.messageId ? { "messaging.message.id": message.properties.messageId } : {}),
      }, "ticket-live-email-worker", 5);
      let parsedMessage: EmailSendV1;
      try {
        parsedMessage = parseEmailCommand(JSON.parse(message.content.toString()));
      } catch {
        finishSpan("error");
        logger.warn("Discarding invalid email command", { messageId: message.properties.messageId, queueName });
        channel.nack(message, false, false);
        return;
      }
      try {
        const wasRecorded = await recordSimulatedDelivery(parsedMessage);
        logger.info(wasRecorded ? "Simulated email delivery recorded" : "Duplicate email command skipped", {
          messageId: message.properties.messageId ?? parsedMessage.commandId,
          commandId: parsedMessage.commandId,
          notificationKey: parsedMessage.notificationKey,
          orderId: parsedMessage.data.orderId,
        });
        finishSpan("ok", { "order.id": parsedMessage.data.orderId });
        channel.ack(message);
      } catch (error) {
        finishSpan("error", { "order.id": parsedMessage.data.orderId });
        logger.error("Failed to record email job; message will be retried", {
          messageId: message.properties.messageId ?? parsedMessage.commandId,
          commandId: parsedMessage.commandId,
          notificationKey: parsedMessage.notificationKey,
          orderId: parsedMessage.data.orderId,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        channel.nack(message, false, true);
      }
    });
  };

  await channel.consume(orderConfirmationQueueName, (message) => consume(orderConfirmationQueueName, message));
  await channel.consume(emailSendQueueName, (message) => consume(emailSendQueueName, message));
  return async () => {
    await channel.close();
    await connection.close();
  };
}
