import type { Request, Response } from "express";
import { z } from "zod";
import { EventServiceError, getEventServiceClient } from "../../services/events/eventServiceClient.ts";
import { createLogger } from "../../observability/logger.ts";

const logger = createLogger("ticket-live-public-api");

const createEventBodySchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().min(1),
    location: z.string().trim().min(1).max(255),
    minPeople: z.number().int().positive(),
    maxPeople: z.number().int().positive(),
    ticketPriceCents: z.number().int().nonnegative(),
    currencyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, "Currency code must be a three-letter ISO code"),
    servesAlcohol: z.boolean().default(false),
    startsAt: z
      .iso.datetime({ offset: true }),
  })
  .refine((event) => event.maxPeople >= event.minPeople, {
    message: "maxPeople must be at least minPeople",
    path: ["maxPeople"],
  });

const searchEventsQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function getAllEvents(_req: Request, res: Response): Promise<void> {
  try { res.status(200).json(await getEventServiceClient().listEvents()); }
  catch (error) { if (error instanceof EventServiceError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
}

export async function getSearchEvents(req: Request, res: Response): Promise<void> {
  const parsedQuery = searchEventsQuerySchema.safeParse(req.query);

  if (!parsedQuery.success) {
    res.status(400).json({ error: "Invalid search query" });
    return;
  }

  try { res.status(200).json(await getEventServiceClient().search(parsedQuery.data.q, parsedQuery.data.limit)); }
  catch (error) { if (error instanceof EventServiceError) { res.status(error.status).json({ error: error.message }); return; } throw error; }
}

export async function postEvent(req: Request, res: Response): Promise<void> {
  const parsedBody = createEventBodySchema.safeParse(req.body);

  if (!parsedBody.success) {
    res.status(400).json({ error: "Invalid event details" });
    return;
  }

  if (!req.auth) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const result = await getEventServiceClient().createEvent(parsedBody.data, req.auth.userId);
    logger.info("Event created", { eventId: result.event.id });
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof EventServiceError) { res.status(error.status).json({ error: error.message }); return; }
    throw error;
  }
}
