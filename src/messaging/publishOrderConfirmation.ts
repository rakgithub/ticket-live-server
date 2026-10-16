import amqp from "amqplib";
import {
  emailSendExchangeName,
  emailSendQueueName,
  emailSendRoutingKey,
  EmailSendV1Schema,
  type EmailSendV1,
} from "@ticket-live/contracts";
import { env } from "../config/env.ts";
import { getTraceContext } from "../observability/traceContext.ts";

async function assertEmailTopology(channel: amqp.ConfirmChannel): Promise<void> {
  await channel.assertExchange(emailSendExchangeName, "direct", { durable: true });
  await channel.assertQueue(emailSendQueueName, { durable: true });
  await channel.bindQueue(emailSendQueueName, emailSendExchangeName, emailSendRoutingKey);
}

/** Publishes the temporary Order-to-Email command through a routed exchange. */
export async function publishEmailSendCommand(
  message: EmailSendV1,
  options: { replay?: boolean } = {},
): Promise<void> {
  const validatedMessage = EmailSendV1Schema.parse(message);
  const traceContext = getTraceContext();
  const connection = await amqp.connect(env.AMQP_URL);
  const channel = await connection.createConfirmChannel();
  let returned: Error | undefined;

  try {
    await assertEmailTopology(channel);
    channel.on("return", (returnedMessage) => {
      returned = new Error(
        `RabbitMQ could not route email command ${returnedMessage.properties.messageId ?? validatedMessage.commandId}`,
      );
    });

    channel.publish(
      emailSendExchangeName,
      emailSendRoutingKey,
      Buffer.from(JSON.stringify(validatedMessage)),
      {
        mandatory: true,
        persistent: true,
        contentType: "application/json",
        messageId: validatedMessage.commandId,
        correlationId: traceContext?.correlationId ?? validatedMessage.commandId,
        type: "email.send.v1",
        timestamp: Math.floor(Date.now() / 1_000),
        headers: {
          ...(traceContext ? { traceparent: traceContext.traceparent } : {}),
          ...(traceContext?.tracestate ? { tracestate: traceContext.tracestate } : {}),
          ...(options.replay ? { "x-email-replay": true } : {}),
        },
      },
    );

    await channel.waitForConfirms();
    // RabbitMQ sends basic.return before the confirm; let the channel process
    // that frame before treating the confirmed publish as successful.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (returned) throw returned;
  } finally {
    await channel.close();
    await connection.close();
  }
}
