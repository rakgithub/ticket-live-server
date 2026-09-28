import { elasticsearch } from "../../search/client.ts";
import { eventsIndexName } from "../../search/eventsIndex.ts";

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
