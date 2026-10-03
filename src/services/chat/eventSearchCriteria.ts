import { z } from "zod";

export const eventSearchCriteriaSchema = z.strictObject({
  text: z.string().trim().min(1).max(120).optional(),
  location: z.string().trim().min(1).max(120).optional(),
});

export type EventSearchCriteria = z.infer<typeof eventSearchCriteriaSchema>;

export const eventSearchIntentSchema = z.strictObject({
  isEventSearch: z.boolean(),
  text: z.string().trim().max(120).nullable(),
  location: z.string().trim().max(120).nullable(),
});

export type EventSearchIntent = z.infer<typeof eventSearchIntentSchema>;

export function normalizeEventSearchIntent(
  intent: EventSearchIntent,
): EventSearchCriteria {
  return eventSearchCriteriaSchema.parse({
    ...(intent.text ? { text: intent.text } : {}),
    ...(intent.location ? { location: intent.location } : {}),
  });
}
