import { asc, eq } from "drizzle-orm";
import { createLogger } from "@ticket-live/runtime";
import { db, pool } from "../db/client.ts";
import { orderOutboxEventsTable } from "../db/schema/orderOutboxEvents.ts";
import { buildOrderConfirmedTicketingEvent } from "../messaging/orderConfirmation.ts";
import { publishTicketingEvent } from "../messaging/publishTicketingEvent.ts";

const logger = createLogger("ticket-live-ticket-replay");

function parseArgs(args: string[]): { apply: boolean; limit: number; offset: number } {
  let apply = false;
  let limit = 10_000;
  let offset = 0;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      if (apply) throw new Error("--apply may only be specified once");
      apply = true;
      continue;
    }
    if (argument !== "--limit" && argument !== "--offset") throw new Error("Unknown option");
    if (seen.has(argument)) throw new Error(`${argument} may only be specified once`);
    seen.add(argument);
    const value = args[index + 1];
    if (!value || !/^\d+$/.test(value)) throw new Error(`${argument} requires a nonnegative integer`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error(`${argument} is too large`);
    if (argument === "--limit") limit = parsed;
    else offset = parsed;
    index += 1;
  }
  if (limit < 1 || limit > 10_000) throw new Error("--limit must be between 1 and 10000");
  return { apply, limit, offset };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rows = await db.select({
    id: orderOutboxEventsTable.id,
    eventType: orderOutboxEventsTable.eventType,
    aggregateId: orderOutboxEventsTable.aggregateId,
    payload: orderOutboxEventsTable.payload,
    createdAt: orderOutboxEventsTable.createdAt,
  }).from(orderOutboxEventsTable)
    .where(eq(orderOutboxEventsTable.eventType, "order.confirmed"))
    .orderBy(asc(orderOutboxEventsTable.createdAt), asc(orderOutboxEventsTable.id))
    .limit(options.limit)
    .offset(options.offset);

  const messages = rows.map((row) => buildOrderConfirmedTicketingEvent(row));
  if (!options.apply) {
    logger.info("Ticket replay dry run validated", {
      count: messages.length,
      limit: options.limit,
      offset: options.offset,
      applyRequired: true,
    });
    return;
  }

  for (const message of messages) await publishTicketingEvent(message);
  logger.info("Confirmed order ticket messages were published", {
    count: messages.length,
    limit: options.limit,
    offset: options.offset,
  });
}

try {
  await main();
} catch (error) {
  logger.error(error instanceof Error ? error.message : "Ticket replay failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
