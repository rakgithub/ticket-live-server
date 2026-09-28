import { Client } from "@elastic/elasticsearch";
import { env } from "../config/env.ts";

export const elasticsearch = new Client({
  node: env.ELASTICSEARCH_URL,
});
