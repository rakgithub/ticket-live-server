import amqp from "amqplib";
import { env } from "../config/env.ts";
import { db } from "../db/client.ts";
import { emailDeliveriesTable } from "../db/schema/emailDeliveries.ts";
import {
  orderConfirmationMessageSchema,
  orderConfirmationQueueName,
  type OrderConfirmationMessage,
} from "../messaging/publishOrderConfirmation.ts";

async function recordSimulatedDelivery(
  message: OrderConfirmationMessage,
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

    let parsedMessage: OrderConfirmationMessage;
    try {
      parsedMessage = orderConfirmationMessageSchema.parse(
        JSON.parse(message.content.toString()),
      );
    } catch (error) {
      console.error("Discarding invalid email job", error);
      channel.nack(message, false, false);
      return;
    }

    try {
      const wasRecorded = await recordSimulatedDelivery(parsedMessage);

      if (wasRecorded) {
        console.log(
          `Would send order confirmation for ${parsedMessage.data.orderId} to ${parsedMessage.data.customer.email}`,
        );
      } else {
        console.log(
          `Skipping duplicate order-confirmation job ${parsedMessage.eventId}`,
        );
      }

      channel.ack(message);
    } catch (error) {
      console.error("Failed to record email job; retrying", error);
      channel.nack(message, false, true);
    }
  });

  return async () => {
    await channel.close();
    await connection.close();
  };
}
