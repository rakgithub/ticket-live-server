import { and, asc, eq } from "drizzle-orm";
import { db, pool } from "../db/client.ts";
import { emailReplayAuditsTable } from "../db/schema/emailReplayAudits.ts";
import { orderOutboxEventsTable } from "../db/schema/orderOutboxEvents.ts";
import { ordersTable } from "../db/schema/orders.ts";
import { createLogger } from "../observability/logger.ts";
import {
  buildOrderConfirmationEmailCommand,
  EmailReplayError,
  parseEmailReplayArgs,
} from "../messaging/orderConfirmation.ts";
import { publishEmailSendCommand } from "../messaging/publishOrderConfirmation.ts";

const logger = createLogger("ticket-live-email-replay");

async function main(): Promise<void> {
  const options = parseEmailReplayArgs(process.argv.slice(2));
  const [order] = await db.select({ id: ordersTable.id, status: ordersTable.status })
    .from(ordersTable)
    .where(eq(ordersTable.id, options.orderId));
  if (!order) throw new EmailReplayError("Order not found");
  if (order.status !== "confirmed") throw new EmailReplayError("Only confirmed orders can be replayed");

  const outboxEvents = await db.select({
    id: orderOutboxEventsTable.id,
    aggregateId: orderOutboxEventsTable.aggregateId,
    payload: orderOutboxEventsTable.payload,
  }).from(orderOutboxEventsTable)
    .where(and(
      eq(orderOutboxEventsTable.eventType, "order.confirmed"),
      eq(orderOutboxEventsTable.aggregateId, order.id),
    ))
    .orderBy(asc(orderOutboxEventsTable.createdAt))
    .limit(2);

  if (outboxEvents.length !== 1) {
    throw new EmailReplayError("Expected exactly one authoritative order.confirmed outbox row");
  }
  const outboxEvent = outboxEvents[0];
  const command = buildOrderConfirmationEmailCommand(outboxEvent);
  if (!options.apply) {
    logger.info("Email replay dry run validated", {
      orderId: order.id,
      commandId: command.commandId,
      notificationKey: command.notificationKey,
      applyRequired: true,
    });
    return;
  }

  const [audit] = await db.insert(emailReplayAuditsTable).values({
    orderId: order.id,
    outboxEventId: outboxEvent.id,
    notificationKey: command.notificationKey,
    requestedBy: options.requestedBy,
    reason: options.reason,
    status: "started",
  }).returning({ id: emailReplayAuditsTable.id });
  if (!audit) throw new Error("Replay audit record could not be created");

  try {
    await publishEmailSendCommand(command, { replay: true });
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    await db.update(emailReplayAuditsTable).set({
      status: "failed",
      errorType,
      finishedAt: new Date(),
    }).where(eq(emailReplayAuditsTable.id, audit.id)).catch(() => undefined);
    logger.error("Order confirmation replay failed", {
      auditId: audit.id,
      orderId: order.id,
      commandId: command.commandId,
      notificationKey: command.notificationKey,
      requestedBy: options.requestedBy,
      errorType,
    });
    throw error;
  }

  await db.update(emailReplayAuditsTable).set({
    status: "published",
    finishedAt: new Date(),
  }).where(eq(emailReplayAuditsTable.id, audit.id));
  logger.info("Order confirmation replay was published", {
    auditId: audit.id,
    orderId: order.id,
    commandId: command.commandId,
    notificationKey: command.notificationKey,
    requestedBy: options.requestedBy,
  });
}

try {
  await main();
} catch (error) {
  if (error instanceof EmailReplayError) logger.error(error.message);
  else {
    logger.error("Email replay command failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
