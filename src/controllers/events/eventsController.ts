import type { Request, Response } from "express";
import { z } from "zod";
import {
  createEvent,
  getEvents,
} from "../../services/events/eventsService.ts";

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
      .iso
      .datetime({ offset: true })
      .transform((value) => new Date(value)),
  })
  .refine((event) => event.maxPeople >= event.minPeople, {
    message: "maxPeople must be at least minPeople",
    path: ["maxPeople"],
  });

export async function getAllEvents(_req: Request, res: Response): Promise<void> {
  const events = await getEvents();
  res.status(200).json({ events });
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

  const event = await createEvent(req.auth.userId, parsedBody.data);
  res.status(201).json({ event });
}
