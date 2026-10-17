import { asc, inArray } from "drizzle-orm";
import { createLogger } from "@ticket-live/runtime";
import { db, pool } from "../db/client.ts";
import { outboxEventsTable } from "../db/schema/outboxEvents.ts";
import { buildEventTicketInvalidation, eventTicketInvalidationTraceHeaders, publishEventTicketInvalidation } from "../messaging/publishTicketingEvent.ts";

const logger = createLogger("ticket-live-event-ticket-replay");

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
  const rows = await db.select().from(outboxEventsTable)
    .where(inArray(outboxEventsTable.eventType, ["event.cancelled", "event.deleted"]))
    .orderBy(asc(outboxEventsTable.createdAt), asc(outboxEventsTable.id))
    .limit(options.limit)
    .offset(options.offset);
  const messages = rows.map(buildEventTicketInvalidation);
  if (!options.apply) {
    logger.info("Ticket invalidation replay dry run validated", {
      count: messages.length,
      limit: options.limit,
      offset: options.offset,
      applyRequired: true,
    });
    return;
  }

  for (const [index, message] of messages.entries()) {
    await publishEventTicketInvalidation(message, eventTicketInvalidationTraceHeaders(rows[index].payload));
  }
  logger.info("Event ticket invalidations were published", {
    count: messages.length,
    limit: options.limit,
    offset: options.offset,
  });
}

try {
  await main();
} catch (error) {
  logger.error(error instanceof Error ? error.message : "Ticket invalidation replay failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
