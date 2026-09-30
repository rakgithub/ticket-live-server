import amqp from "amqplib";
import { z } from "zod";
import { env } from "../config/env.ts";

export const orderConfirmationQueueName = "booking-confirmation-email";

export const orderConfirmationMessageSchema = z.object({
  eventId: z.uuid(),
  eventType: z.literal("order.confirmed"),
  occurredAt: z.iso.datetime(),
  data: z.object({
    orderId: z.uuid(),
    customer: z.object({
      name: z.string().min(1),
      email: z.email(),
    }),
    event: z.object({
      id: z.uuid(),
      name: z.string().min(1),
      location: z.string().min(1),
      startsAt: z.iso.datetime(),
    }),
    quantity: z.number().int().positive(),
    ticketPriceCents: z.number().int().nonnegative(),
    totalAmountCents: z.number().int().nonnegative(),
    currencyCode: z.string().length(3),
  }),
});

export type OrderConfirmationMessage = z.infer<
  typeof orderConfirmationMessageSchema
>;

export async function publishOrderConfirmation(
  message: OrderConfirmationMessage,
): Promise<void> {
  const connection = await amqp.connect(env.AMQP_URL);
  const channel = await connection.createConfirmChannel();

  try {
    await channel.assertQueue(orderConfirmationQueueName, { durable: true });

    channel.sendToQueue(
      orderConfirmationQueueName,
      Buffer.from(JSON.stringify(message)),
      {
        persistent: true,
        contentType: "application/json",
        messageId: message.eventId,
        type: message.eventType,
      },
    );

    await channel.waitForConfirms();
  } finally {
    await channel.close();
    await connection.close();
  }
}
