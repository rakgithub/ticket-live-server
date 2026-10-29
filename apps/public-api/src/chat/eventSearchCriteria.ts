import { z } from "zod";
import { EVENT_GENRES, EventGenreSchema, type EventGenre } from "@ticket-live/contracts";

export const eventSearchCriteriaSchema = z.strictObject({
  text: z.string().trim().min(1).max(120).optional(),
  location: z.string().trim().min(1).max(120).optional(),
  genre: EventGenreSchema.optional(),
});

export type EventSearchCriteria = z.infer<typeof eventSearchCriteriaSchema>;

export const eventSearchIntentSchema = z.strictObject({
  isEventSearch: z.boolean(),
  text: z.string().trim().max(120).nullable(),
  location: z.string().trim().max(120).nullable(),
  genre: EventGenreSchema.nullable().default(null),
  needsClarification: z.boolean().default(false),
});

export type EventSearchIntent = z.output<typeof eventSearchIntentSchema>;
export type EventSearchIntentInput = z.input<typeof eventSearchIntentSchema>;

function normalizePhrase(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function genrePattern(genre: EventGenre): RegExp {
  const escaped = genre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("-", "[-\\s]+");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])(${escaped})(?=$|[^\\p{L}\\p{N}])`, "giu");
}

function removeGenreFromText(text: string | null, genre: EventGenre): string | null {
  if (!text) return text;
  const remaining = text
    .replace(genrePattern(genre), " ")
    .replace(/\s+/g, " ")
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "")
    .trim();
  return remaining || null;
}

function isNegatedMention(message: string, index: number): boolean {
  const precedingText = message.slice(Math.max(0, index - 36), index);
  return /\b(?:no|not|without|except|exclude|excluding|avoid)\s+(?:the\s+)?(?:\w+\s+){0,2}$/iu.test(precedingText);
}

function getExplicitGenreMentions(message: string): {
  included: EventGenre[];
  excluded: EventGenre[];
} {
  const normalizedMessage = normalizePhrase(message);
  const included: EventGenre[] = [];
  const excluded: EventGenre[] = [];

  for (const genre of EVENT_GENRES) {
    const pattern = genrePattern(genre);
    for (const match of normalizedMessage.matchAll(pattern)) {
      const index = match.index + match[0].indexOf(match[1] ?? "");
      (isNegatedMention(normalizedMessage, index) ? excluded : included).push(genre);
    }
  }

  return {
    included: [...new Set(included)],
    excluded: [...new Set(excluded)],
  };
}

export type EventSearchIntentResolution = {
  modelCriteria: EventSearchCriteria;
  criteria: EventSearchCriteria;
  needsClarification: boolean;
  genreOverridden: boolean;
};

/** Resolve explicit genre words deterministically before using model output. */
export function resolveEventSearchIntent(
  message: string,
  intent: EventSearchIntent,
): EventSearchIntentResolution {
  const mentions = getExplicitGenreMentions(message);
  const modelCriteria = normalizeEventSearchIntent(intent);
  const hasNegativeConstraint = mentions.excluded.length > 0;
  const needsClarification = () => ({
    modelCriteria,
    criteria: {} as EventSearchCriteria,
    needsClarification: true,
    genreOverridden: false,
  });

  if (
    intent.location &&
    !normalizePhrase(message).includes(normalizePhrase(intent.location))
  ) return needsClarification();

  if (intent.needsClarification) return needsClarification();
  if (mentions.included.length > 1) return needsClarification();
  if (mentions.included.length === 0 && hasNegativeConstraint) return needsClarification();

  const explicitGenre = mentions.included[0];
  if (explicitGenre) {
    const criteria = normalizeEventSearchIntent({
      ...intent,
      text: removeGenreFromText(intent.text, explicitGenre),
      genre: explicitGenre,
    });
    return {
      modelCriteria,
      criteria,
      needsClarification: false,
      genreOverridden: intent.genre !== explicitGenre,
    };
  }

  // A model-selected genre is never accepted unless the deterministic scanner
  // found the same supported genre as a standalone word in the user message.
  if (intent.genre) return needsClarification();

  return {
    modelCriteria,
    criteria: normalizeEventSearchIntent(intent),
    needsClarification: false,
    genreOverridden: false,
  };
}

export function normalizeEventSearchIntent(
  intent: EventSearchIntentInput,
): EventSearchCriteria {
  return eventSearchCriteriaSchema.parse({
    ...(intent.text ? { text: intent.text } : {}),
    ...(intent.location ? { location: intent.location } : {}),
    ...(intent.genre ? { genre: intent.genre } : {}),
  });
}
