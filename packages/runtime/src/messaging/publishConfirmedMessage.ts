import amqp from "amqplib";

export async function publishConfirmedMessage(input: {
  url: string;
  exchange: string;
  routingKey: string;
  message: unknown;
  messageId: string;
  correlationId: string;
  type: string;
  autoDeclareTopology: boolean;
  headers?: Record<string, unknown>;
}): Promise<void> {
  const connection = await amqp.connect(input.url);
  const channel = await connection.createConfirmChannel();
  let returned = false;

  try {
    if (input.autoDeclareTopology) {
      await channel.assertExchange(input.exchange, "direct", { durable: true });
    }
    const onReturn = (message: amqp.Message) => {
      if (message.properties.messageId === input.messageId) returned = true;
    };
    channel.on("return", onReturn);
    try {
      channel.publish(input.exchange, input.routingKey, Buffer.from(JSON.stringify(input.message)), {
        mandatory: true,
        persistent: true,
        contentType: "application/json",
        messageId: input.messageId,
        correlationId: input.correlationId,
        type: input.type,
        timestamp: Math.floor(Date.now() / 1_000),
        headers: input.headers,
      });
      await channel.waitForConfirms();
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (returned) throw new Error(`RabbitMQ could not route ${input.type} message ${input.messageId}`);
    } finally {
      channel.off("return", onReturn);
    }
  } finally {
    await channel.close();
    await connection.close();
  }
}
