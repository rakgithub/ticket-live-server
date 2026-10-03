import type { estypes } from "@elastic/elasticsearch";
import { elasticsearch } from "../../search/client.ts";
import { eventsIndexName } from "../../search/eventsIndex.ts";
import type { EventSearchCriteria } from "../chat/eventSearchCriteria.ts";

type EventSearchDocument = {
  id: string;
  name: string;
  description: string;
  location: string;
  minPeople: number;
  maxPeople: number;
  reservedQuantity: number;
  ticketPriceCents: number;
  currencyCode: string;
  servesAlcohol: boolean;
  isCancelled: boolean;
  userId: string;
  startsAt: string;
  createdAt: string;
  updatedAt: string;
};

export type SearchEventsInput = {
  query: string;
  limit: number;
};

export type EventSearchCandidate = {
  id: string;
  score: number | null;
};

export class EventSearchUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Event search is currently unavailable", { cause });
    this.name = "EventSearchUnavailableError";
  }
}

/**
 * Finds event IDs using structured criteria. Elasticsearch is only a candidate
 * index; callers must verify and project results from PostgreSQL before
 * returning them to clients.
 */
export async function searchEventCandidates(
  criteria: EventSearchCriteria,
  { limit, now = new Date() }: { limit: number; now?: Date },
): Promise<EventSearchCandidate[]> {
  const filters: estypes.QueryDslQueryContainer[] = [
    { term: { isCancelled: false } },
    { range: { startsAt: { gte: now.toISOString() } } },
    ...(criteria.location
      ? [
          {
            match: {
              location: {
                query: criteria.location,
                operator: "and" as const,
                fuzziness: "AUTO" as const,
              },
            },
          },
        ]
      : []),
  ];

  const must: estypes.QueryDslQueryContainer[] = criteria.text
    ? [
        {
          multi_match: {
            query: criteria.text,
            fields: ["name^3", "description"],
            type: "best_fields" as const,
            operator: "and" as const,
            fuzziness: "AUTO" as const,
          },
        },
      ]
    : [{ match_all: {} }];

  try {
    const response = await elasticsearch.search({
      index: eventsIndexName,
      size: Math.min(50, Math.max(limit, limit * 3)),
      timeout: "3s",
      _source: false,
      track_total_hits: false,
      query: { bool: { must, filter: filters } },
      sort: [{ _score: { order: "desc" } }, { startsAt: { order: "asc" } }],
    });

    return response.hits.hits.flatMap((hit) =>
      hit._id ? [{ id: hit._id, score: hit._score }] : [],
    );
  } catch (error) {
    throw new EventSearchUnavailableError(error);
  }
}

export async function searchEvents({ query, limit }: SearchEventsInput) {
  const response = await elasticsearch.search<EventSearchDocument>({
    index: eventsIndexName,
    size: limit,
    query: {
      bool: {
        must: [
          {
            multi_match: {
              query,
              fields: ["name^3", "description", "location^2"],
              type: "best_fields",
              operator: "and",
              fuzziness: "AUTO",
            },
          },
        ],
        filter: [{ term: { isCancelled: false } }],
      },
    },
    sort: ["_score", { startsAt: { order: "asc" } }],
  });

  return response.hits.hits.flatMap((hit) => {
    if (!hit._source) return [];

    return [{ ...hit._source, score: hit._score }];
  });
}
