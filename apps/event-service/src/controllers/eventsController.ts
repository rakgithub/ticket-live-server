import type { Request, Response } from "express";
import { z } from "zod";
import { EventGenreSchema, InternalEventChatCardsResponseSchema, InternalEventSearchCandidatesResponseSchema } from "@ticket-live/contracts";
import { EventSearchUnavailableError, searchEvents, searchEventCandidates } from "../services/eventsSearchService.ts";
import { cancelEvent, createEvent, deleteEvent, EventUpdateError, getEventChatCards, getEvents, updateEvent } from "../services/eventsService.ts";

const eventFieldsSchema = z.object({
  name: z.string().trim().min(1).max(255), description: z.string().trim().min(1), location: z.string().trim().min(1).max(255),
  genre: z.preprocess((value) => typeof value === "string" ? value.trim().toLowerCase().replace(/[ _]+/g, "-") : value, EventGenreSchema.nullable()).optional(),
  minPeople: z.number().int().positive(), maxPeople: z.number().int().positive(), ticketPriceCents: z.number().int().nonnegative(),
  currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/), servesAlcohol: z.boolean(), startsAt: z.iso.datetime({ offset: true }),
});
const createEventSchema = eventFieldsSchema.extend({ servesAlcohol: z.boolean().default(false) }).refine((event) => event.maxPeople >= event.minPeople, { path: ["maxPeople"], message: "maxPeople must be at least minPeople" });
const updateEventSchema = eventFieldsSchema.partial().strict().superRefine((event, context) => {
  if (event.minPeople !== undefined && event.maxPeople !== undefined && event.maxPeople < event.minPeople) context.addIssue({ code: "custom", path: ["maxPeople"], message: "maxPeople must be at least minPeople" });
});
function serializeEvent(event: Record<string, unknown>) {
  return { ...event, currencyCode: typeof event.currencyCode === "string" ? event.currencyCode.trim() : event.currencyCode,
    startsAt: event.startsAt instanceof Date ? event.startsAt.toISOString() : event.startsAt,
    createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : event.createdAt,
    updatedAt: event.updatedAt instanceof Date ? event.updatedAt.toISOString() : event.updatedAt };
}

export async function listEvents(_req: Request, res: Response): Promise<void> { res.json({ events: (await getEvents()).map(serializeEvent) }); }
export async function searchEventsController(req: Request, res: Response): Promise<void> {
  const parsed = z.object({ q: z.string().trim().min(1).max(200), limit: z.coerce.number().int().min(1).max(50).default(20) }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid search query" }); return; }
  res.json({ events: (await searchEvents({ query: parsed.data.q, limit: parsed.data.limit })).map(serializeEvent) });
}
export async function createEventController(req: Request, res: Response): Promise<void> {
  const input = createEventSchema.safeParse(req.body); const actor = z.uuid().safeParse(req.header("x-actor-user-id"));
  if (!input.success || !actor.success) { res.status(400).json({ error: "Invalid event details" }); return; }
  const event = await createEvent(actor.data, { ...input.data, startsAt: new Date(input.data.startsAt) });
  res.status(201).json({ event: serializeEvent(event) });
}
export async function updateEventController(req: Request, res: Response): Promise<void> {
  const id = z.uuid().safeParse(req.params.eventId); const actor = z.uuid().safeParse(req.header("x-actor-user-id")); const input = updateEventSchema.safeParse(req.body);
  if (!id.success || !actor.success || !input.success || Object.keys(input.data).length === 0) { res.status(400).json({ error: "Invalid event details" }); return; }
  const { startsAt, ...fields } = input.data;
  const event = await updateEvent(actor.data, id.data, { ...fields, ...(startsAt ? { startsAt: new Date(startsAt) } : {}) });
  if (!event) { res.status(404).json({ error: "Event not found" }); return; }
  res.json({ event: serializeEvent(event) });
}
export async function cancelEventController(req: Request, res: Response): Promise<void> {
  const id = z.uuid().safeParse(req.params.eventId); const actor = z.uuid().safeParse(req.header("x-actor-user-id"));
  if (!id.success || !actor.success) { res.status(400).json({ error: "Invalid event details" }); return; }
  const event = await cancelEvent(actor.data, id.data);
  if (!event) { res.status(404).json({ error: "Event not found" }); return; }
  res.json({ event: serializeEvent(event) });
}
export async function deleteEventController(req: Request, res: Response): Promise<void> {
  const id = z.uuid().safeParse(req.params.eventId); const actor = z.uuid().safeParse(req.header("x-actor-user-id"));
  if (!id.success || !actor.success) { res.status(400).json({ error: "Invalid event details" }); return; }
  const event = await deleteEvent(actor.data, id.data);
  if (!event) { res.status(404).json({ error: "Event not found" }); return; }
  res.status(204).end();
}
export async function eventSearchCandidates(req: Request, res: Response): Promise<void> {
  const parsed = z.object({ text: z.string().trim().min(1).max(120).optional(), location: z.string().trim().min(1).max(120).optional(), genre: EventGenreSchema.optional(), limit: z.coerce.number().int().min(1).max(50).default(10) }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid event search" }); return; }
  res.json(InternalEventSearchCandidatesResponseSchema.parse({ candidates: await searchEventCandidates(parsed.data, { limit: parsed.data.limit }) }));
}
export async function eventCards(req: Request, res: Response): Promise<void> {
  const parsed = z.object({ ids: z.string().min(1), genre: EventGenreSchema.optional(), location: z.string().trim().min(1).max(120).optional(), limit: z.coerce.number().int().min(1).max(10).default(5) }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid event card request" }); return; }
  const ids = parsed.data.ids.split(",");
  if (!ids.every((id) => z.uuid().safeParse(id).success)) { res.status(400).json({ error: "Invalid event card request" }); return; }
  res.json(InternalEventChatCardsResponseSchema.parse({ cards: await getEventChatCards(ids, { limit: parsed.data.limit, genre: parsed.data.genre, location: parsed.data.location }) }));
}
export { EventUpdateError, EventSearchUnavailableError };
