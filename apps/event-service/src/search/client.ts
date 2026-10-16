import { Client } from "@elastic/elasticsearch";
import { env } from "@ticket-live/runtime";

export const elasticsearch = new Client({
  node: env.ELASTICSEARCH_URL,
});
