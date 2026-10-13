import amqp from "amqplib";
import {
  OrderConfirmedV1Schema,
  type OrderConfirmedV1,
} from "@ticket-live/contracts";
import { env } from "../config/env.ts";
import { getTraceContext } from "../observability/traceContext.ts";

export const orderConfirmationQueueName = "booking-confirmation-email";

export type OrderConfirmationMessage = OrderConfirmedV1;

export async function publishOrderConfirmation(
  message: OrderConfirmationMessage,
): Promise<void> {
  const validatedMessage = OrderConfirmedV1Schema.parse(message);
  const traceContext = getTraceContext();
  const connection = await amqp.connect(env.AMQP_URL);
  const channel = await connection.createConfirmChannel();

  try {
    await channel.assertQueue(orderConfirmationQueueName, { durable: true });

    channel.sendToQueue(
      orderConfirmationQueueName,
      Buffer.from(JSON.stringify(validatedMessage)),
      {
        persistent: true,
        contentType: "application/json",
        messageId: validatedMessage.eventId,
        correlationId: validatedMessage.correlationId,
        type: "order.confirmed.v1",
        headers: {
          ...(traceContext ? { traceparent: traceContext.traceparent } : {}),
          ...(traceContext?.tracestate ? { tracestate: traceContext.tracestate } : {}),
        },
      },
    );

    await channel.waitForConfirms();
  } finally {
    await channel.close();
    await connection.close();
  }
}
