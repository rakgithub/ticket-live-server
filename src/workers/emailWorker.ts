import amqp from "amqplib";
import { env } from "../config/env.ts";
import { db } from "../db/client.ts";
import { emailDeliveriesTable } from "../db/schema/emailDeliveries.ts";
import {
  parseOrderConfirmedMessage,
  type OrderConfirmedV1,
} from "@ticket-live/contracts";
import { orderConfirmationQueueName } from "../messaging/publishOrderConfirmation.ts";
import { createLogger } from "../observability/logger.ts";
import {
  createMessageTraceContext,
  runWithTraceContext,
} from "../observability/traceContext.ts";
import { startSpan } from "../observability/traceExporter.ts";

const logger = createLogger("ticket-live-email-worker");

async function recordSimulatedDelivery(
  message: OrderConfirmedV1,
): Promise<boolean> {
  const [delivery] = await db
    .insert(emailDeliveriesTable)
    .values({
      eventId: message.eventId,
      orderId: message.data.orderId,
      recipientEmail: message.data.customer.email,
      status: "simulated",
    })
    .onConflictDoNothing({ target: emailDeliveriesTable.eventId })
    .returning({ id: emailDeliveriesTable.id });

  return Boolean(delivery);
}

export async function startEmailWorker(): Promise<() => Promise<void>> {
  const connection = await amqp.connect(env.AMQP_URL);
  const channel = await connection.createChannel();

  await channel.assertQueue(orderConfirmationQueueName, { durable: true });
  await channel.prefetch(1);

  await channel.consume(orderConfirmationQueueName, async (message) => {
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
        "messaging.destination.name": orderConfirmationQueueName,
        ...(message.properties.messageId
          ? { "messaging.message.id": message.properties.messageId }
          : {}),
      }, "ticket-live-email-worker", 5);
      let parsedMessage: OrderConfirmedV1;
      try {
        parsedMessage = parseOrderConfirmedMessage(
          JSON.parse(message.content.toString()),
        );
      } catch {
        finishSpan("error");
        logger.warn("Discarding invalid order confirmation message", {
          messageId: message.properties.messageId,
        });
        channel.nack(message, false, false);
        return;
      }

      try {
        const wasRecorded = await recordSimulatedDelivery(parsedMessage);
        if (wasRecorded) {
          logger.info("Simulated email delivery recorded", {
            messageId: message.properties.messageId ?? parsedMessage.eventId,
            eventId: parsedMessage.eventId,
            orderId: parsedMessage.data.orderId,
          });
        } else {
          logger.info("Duplicate order confirmation skipped", {
            messageId: message.properties.messageId ?? parsedMessage.eventId,
            eventId: parsedMessage.eventId,
            orderId: parsedMessage.data.orderId,
          });
        }

        finishSpan("ok", { "order.id": parsedMessage.data.orderId });
        channel.ack(message);
      } catch (error) {
        finishSpan("error", { "order.id": parsedMessage.data.orderId });
        logger.error("Failed to record email job; message will be retried", {
          messageId: message.properties.messageId ?? parsedMessage.eventId,
          eventId: parsedMessage.eventId,
          orderId: parsedMessage.data.orderId,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        channel.nack(message, false, true);
      }
    });
  });

  return async () => {
    await channel.close();
    await connection.close();
  };
}
