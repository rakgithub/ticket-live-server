import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import { requireInternalServiceAuth } from "@ticket-live/runtime";
import { env } from "@ticket-live/runtime";
import { pool } from "./db/client.ts";
import { createLogger } from "@ticket-live/runtime";
import { elasticsearch } from "./search/client.ts";
import { EventSearchUnavailableError, searchEvents, searchEventCandidates } from "./services/eventsSearchService.ts";
import { cancelEvent, createEvent, deleteEvent, EventUpdateError, getEventChatCards, getEvents, updateEvent } from "./services/eventsService.ts";
import { confirmInventoryHold, createInventoryHold, expireExpiredInventoryHolds, getInventoryHold, InventoryHoldError, releaseInventoryHold } from "./services/inventoryHoldsService.ts";
import {
  InternalEventChatCardsResponseSchema,
  InternalEventSearchCandidatesResponseSchema,
  InventoryHoldCreateRequestSchema,
  InventoryHoldResponseSchema,
} from "@ticket-live/contracts";
import { processEventOutboxBatch } from "./outboxWorker.ts";
import { httpObservabilityMiddleware } from "@ticket-live/runtime";
import { exportOtlpMetrics } from "@ticket-live/runtime";
import { renderHttpMetrics } from "@ticket-live/runtime";
import { getInventoryHoldCounters } from "./services/inventoryHoldsService.ts";

const logger = createLogger("ticket-live-event-service");
const app = express();
app.use(httpObservabilityMiddleware);
app.use(express.json({ limit: "100kb" }));

const eventFieldsSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().min(1),
  location: z.string().trim().min(1).max(255),
  minPeople: z.number().int().positive(),
  maxPeople: z.number().int().positive(),
  ticketPriceCents: z.number().int().nonnegative(),
  currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  servesAlcohol: z.boolean(),
  startsAt: z.iso.datetime({ offset: true }),
});
const createEventSchema = eventFieldsSchema.extend({
  servesAlcohol: z.boolean().default(false),
}).refine((event) => event.maxPeople >= event.minPeople, {
  path: ["maxPeople"],
  message: "maxPeople must be at least minPeople",
});
const updateEventSchema = eventFieldsSchema.partial().strict().superRefine((event, context) => {
  if (event.minPeople !== undefined && event.maxPeople !== undefined && event.maxPeople < event.minPeople) {
    context.addIssue({ code: "custom", path: ["maxPeople"], message: "maxPeople must be at least minPeople" });
  }
});

function serializeEvent(event: Record<string, unknown>) {
  return {
    ...event,
    currencyCode: typeof event.currencyCode === "string" ? event.currencyCode.trim() : event.currencyCode,
    startsAt: event.startsAt instanceof Date ? event.startsAt.toISOString() : event.startsAt,
    createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : event.createdAt,
    updatedAt: event.updatedAt instanceof Date ? event.updatedAt.toISOString() : event.updatedAt,
  };
}
function serializeHold(hold: Awaited<ReturnType<typeof getInventoryHold>>) {
  return InventoryHoldResponseSchema.parse({ hold: { ...hold, currencyCode: hold.currencyCode.trim(), eventStartsAtSnapshot: hold.eventStartsAtSnapshot.toISOString(), expiresAt: hold.expiresAt.toISOString(), createdAt: hold.createdAt.toISOString(), updatedAt: hold.updatedAt.toISOString() } });
}

app.use("/internal", requireInternalServiceAuth);
app.get("/internal/events", async (_req, res) => res.json({ events: (await getEvents()).map(serializeEvent) }));
app.get("/internal/events/search", async (req, res) => {
  const parsed = z.object({ q: z.string().trim().min(1).max(200), limit: z.coerce.number().int().min(1).max(50).default(20) }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid search query" }); return; }
  res.json({ events: (await searchEvents({ query: parsed.data.q, limit: parsed.data.limit })).map(serializeEvent) });
});
app.post("/internal/events", async (req, res) => {
  const input = createEventSchema.safeParse(req.body); const actor = z.uuid().safeParse(req.header("x-actor-user-id"));
  if (!input.success || !actor.success) { res.status(400).json({ error: "Invalid event details" }); return; }
  const event = await createEvent(actor.data, { ...input.data, startsAt: new Date(input.data.startsAt) });
  res.status(201).json({ event: serializeEvent(event) });
});
app.patch("/internal/events/:eventId", async (req, res) => {
  const id = z.uuid().safeParse(req.params.eventId); const actor = z.uuid().safeParse(req.header("x-actor-user-id"));
  const input = updateEventSchema.safeParse(req.body);
  if (!id.success || !actor.success || !input.success || Object.keys(input.data).length === 0) { res.status(400).json({ error: "Invalid event details" }); return; }
  const { startsAt, ...fields } = input.data;
  const event = await updateEvent(actor.data, id.data, { ...fields, ...(startsAt ? { startsAt: new Date(startsAt) } : {}) });
  if (!event) { res.status(404).json({ error: "Event not found" }); return; }
  res.json({ event: serializeEvent(event) });
});
app.post("/internal/events/:eventId/cancel", async (req, res) => {
  const id = z.uuid().safeParse(req.params.eventId); const actor = z.uuid().safeParse(req.header("x-actor-user-id"));
  if (!id.success || !actor.success) { res.status(400).json({ error: "Invalid event details" }); return; }
  const event = await cancelEvent(actor.data, id.data);
  if (!event) { res.status(404).json({ error: "Event not found" }); return; }
  res.json({ event: serializeEvent(event) });
});
app.delete("/internal/events/:eventId", async (req, res) => {
  const id = z.uuid().safeParse(req.params.eventId); const actor = z.uuid().safeParse(req.header("x-actor-user-id"));
  if (!id.success || !actor.success) { res.status(400).json({ error: "Invalid event details" }); return; }
  const event = await deleteEvent(actor.data, id.data);
  if (!event) { res.status(404).json({ error: "Event not found" }); return; }
  res.status(204).end();
});
app.get("/internal/event-search", async (req, res) => {
  const parsed = z.object({ text: z.string().trim().min(1).max(120).optional(), location: z.string().trim().min(1).max(120).optional(), limit: z.coerce.number().int().min(1).max(50).default(10) }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid event search" }); return; }
  res.json(InternalEventSearchCandidatesResponseSchema.parse({
    candidates: await searchEventCandidates(parsed.data, { limit: parsed.data.limit }),
  }));
});
app.get("/internal/event-cards", async (req, res) => {
  const parsed = z.object({ ids: z.string().min(1), limit: z.coerce.number().int().min(1).max(10).default(5) }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid event card request" }); return; }
  const ids = parsed.data.ids.split(","); if (!ids.every((id) => z.uuid().safeParse(id).success)) { res.status(400).json({ error: "Invalid event card request" }); return; }
  res.json(InternalEventChatCardsResponseSchema.parse({
    cards: await getEventChatCards(ids, { limit: parsed.data.limit }),
  }));
});
app.post("/internal/events/:eventId/holds", async (req, res) => {
  const eventId = z.uuid().safeParse(req.params.eventId); const body = InventoryHoldCreateRequestSchema.safeParse(req.body); const key = z.uuid().safeParse(req.header("idempotency-key"));
  if (!eventId.success || !body.success || !key.success || key.data !== body.data.orderId) { res.status(400).json({ error: "Invalid inventory hold request" }); return; }
  const result = await createInventoryHold({ eventId: eventId.data, ...body.data }); res.status(result.created ? 201 : 200).json(serializeHold(result.hold));
});
for (const [path, action] of [["/internal/holds/:holdId/confirm", confirmInventoryHold], ["/internal/holds/:holdId/release", releaseInventoryHold]] as const) app.post(path, async (req, res) => { const id = z.uuid().safeParse(req.params.holdId); if (!id.success) { res.status(400).json({ error: "Invalid inventory hold ID" }); return; } res.json(serializeHold(await action(id.data))); });
app.get("/internal/holds/:holdId", async (req, res) => { const id = z.uuid().safeParse(req.params.holdId); if (!id.success) { res.status(400).json({ error: "Invalid inventory hold ID" }); return; } res.json(serializeHold(await getInventoryHold(id.data))); });
app.get("/health/live", (_req, res) => res.status(200).json({ status: "ok" }));
app.get("/health/ready", async (_req, res) => {
  const [postgres, elasticsearchStatus] = await Promise.allSettled([pool.query("SELECT 1"), elasticsearch.ping({}, { requestTimeout: 1_000 })]);
  const checks = { postgres: postgres.status === "fulfilled", elasticsearch: elasticsearchStatus.status === "fulfilled" };
  const ready = checks.postgres && checks.elasticsearch;
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
});
app.get("/metrics", async (_req, res) => {
  let outbox: { pending: number; oldestAgeSeconds: number } | undefined;
  let holds: { active: number; oldestAgeSeconds: number } | undefined;
  try {
    const result = await pool.query<{ pending: string; oldest_age_seconds: string | null }>(`
      SELECT COUNT(*)::text AS pending,
        GREATEST(0, EXTRACT(EPOCH FROM (NOW() - MIN(created_at))))::text AS oldest_age_seconds
      FROM event_service.outbox_events
      WHERE processed_at IS NULL
    `);
    outbox = {
      pending: Number(result.rows[0]?.pending ?? 0),
      oldestAgeSeconds: Number(result.rows[0]?.oldest_age_seconds ?? 0),
    };
    const holdResult = await pool.query<{ active: string; oldest_age_seconds: string | null }>(`
      SELECT COUNT(*)::text AS active,
        GREATEST(0, EXTRACT(EPOCH FROM (NOW() - MIN(created_at))))::text AS oldest_age_seconds
      FROM event_service.inventory_holds
      WHERE state = 'active'
    `);
    holds = {
      active: Number(holdResult.rows[0]?.active ?? 0),
      oldestAgeSeconds: Number(holdResult.rows[0]?.oldest_age_seconds ?? 0),
    };
  } catch {
    // HTTP metrics remain available while readiness reports a database outage.
  }
  exportOtlpMetrics(outbox, "ticket-live-event-service");
  const counters = getInventoryHoldCounters();
  res.type("text/plain; version=0.0.4; charset=utf-8").send(renderHttpMetrics(outbox, {
    ...(holds ? { holds: {
      ...holds,
      capacityConflictsTotal: counters.capacityConflictsTotal,
      expiredTotal: counters.expiredHoldsTotal,
    } } : {}),
  }));
});
const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof EventUpdateError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof InventoryHoldError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof EventSearchUnavailableError) {
    res.status(503).json({ error: error.message });
    return;
  }
  logger.error("Event service request failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
  res.status(500).json({ error: "Internal server error" });
};
app.use(errorHandler);
const server = app.listen(env.EVENT_SERVICE_PORT, () => logger.info("Event service listening", { port: env.EVENT_SERVICE_PORT }));
const timer = setInterval(() => void expireExpiredInventoryHolds().catch((error) => logger.error("Hold expiry failed", { errorType: error instanceof Error ? error.name : "UnknownError" })), env.INVENTORY_HOLD_EXPIRY_POLL_INTERVAL_MS);
timer.unref();
const outboxTimer = setInterval(() => void processEventOutboxBatch().catch((error) => logger.error("Event outbox failed", { errorType: error instanceof Error ? error.name : "UnknownError" })), env.OUTBOX_POLL_INTERVAL_MS);
outboxTimer.unref();
void processEventOutboxBatch().catch((error) => logger.error("Event outbox failed", { errorType: error instanceof Error ? error.name : "UnknownError" }));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { clearInterval(timer); clearInterval(outboxTimer); server.close(); void pool.end(); });
