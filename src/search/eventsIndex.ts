import { elasticsearch } from "./client.ts";

export const eventsIndexName = "events";

let indexReady = false;

export async function ensureEventsIndex(): Promise<void> {
  if (indexReady) return;

  const exists = await elasticsearch.indices.exists({ index: eventsIndexName });

  if (!exists) {
    await elasticsearch.indices.create({
      index: eventsIndexName,
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
      },
      mappings: {
        properties: {
          id: { type: "keyword" },
          name: {
            type: "text",
            fields: { keyword: { type: "keyword", ignore_above: 256 } },
          },
          description: { type: "text" },
          location: {
            type: "text",
            fields: { keyword: { type: "keyword", ignore_above: 256 } },
          },
          minPeople: { type: "integer" },
          maxPeople: { type: "integer" },
          reservedQuantity: { type: "integer" },
          ticketPriceCents: { type: "integer" },
          currencyCode: { type: "keyword" },
          servesAlcohol: { type: "boolean" },
          isCancelled: { type: "boolean" },
          userId: { type: "keyword" },
          startsAt: { type: "date" },
          createdAt: { type: "date" },
          updatedAt: { type: "date" },
        },
      },
    });
  }

  indexReady = true;
}
