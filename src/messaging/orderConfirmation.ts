import { EmailSendV1Schema, type EmailSendV1 } from "@ticket-live/contracts";

export type OrderConfirmedOutboxEvent = {
  id: string;
  aggregateId: string;
  payload: Record<string, unknown>;
};

/** Builds the stable Email command from the immutable Order outbox snapshot. */
export function buildOrderConfirmationEmailCommand(
  event: OrderConfirmedOutboxEvent,
): EmailSendV1 {
  const payload = { ...event.payload };
  delete payload.__telemetry;
  const order = payload as {
    orderId: string;
    customer: { name: string; email: string };
    event: { name: string; location: string; startsAt: string };
    quantity: number;
    totalAmountCents: number;
    currencyCode: string;
  };
  if (order.orderId !== event.aggregateId) {
    throw new Error("Order confirmation payload does not match its outbox aggregate ID");
  }

  return EmailSendV1Schema.parse({
    commandId: event.id,
    commandType: "email.send",
    schemaVersion: 1,
    notificationKey: `order-confirmation:${event.aggregateId}`,
    templateId: "order-confirmation-v1",
    recipient: order.customer.email,
    data: {
      orderId: order.orderId,
      customerName: order.customer.name,
      eventName: order.event.name,
      eventLocation: order.event.location,
      eventStartsAt: order.event.startsAt,
      quantity: order.quantity,
      totalAmountCents: order.totalAmountCents,
      currencyCode: order.currencyCode,
    },
  });
}

export type ReplayOptions = {
  orderId: string;
  requestedBy: string;
  reason: string;
  apply: boolean;
};

export class EmailReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailReplayError";
  }
}

/** Parses a deliberately single-order replay command; one invocation is the batch bound. */
export function parseEmailReplayArgs(args: string[]): ReplayOptions {
  const values = new Map<string, string>();
  let apply = false;
  const known = new Set(["--order-id", "--requested-by", "--reason"]);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      if (apply) throw new EmailReplayError("--apply may only be specified once");
      apply = true;
      continue;
    }
    if (!known.has(argument)) throw new EmailReplayError("Unknown option");
    if (values.has(argument)) throw new EmailReplayError(`${argument} may only be specified once`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new EmailReplayError(`${argument} requires a value`);
    values.set(argument, value);
    index += 1;
  }

  const orderId = values.get("--order-id");
  const requestedBy = values.get("--requested-by")?.trim();
  const reason = values.get("--reason")?.trim();
  if (!orderId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) {
    throw new EmailReplayError("--order-id must be a UUID");
  }
  if (!requestedBy || requestedBy.length > 255) {
    throw new EmailReplayError("--requested-by must contain 1 to 255 characters");
  }
  if (!reason || reason.length > 2_000) {
    throw new EmailReplayError("--reason must contain 1 to 2000 characters");
  }

  return { orderId, requestedBy, reason, apply };
}
