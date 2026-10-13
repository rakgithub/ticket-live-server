import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../config/env.ts";
import { createLogger } from "../observability/logger.ts";

const logger = createLogger("ticket-live-public-api");

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (error) => {
  logger.error("Unexpected error from an idle PostgreSQL client", {
    errorType: error.name,
  });
});

export const db = drizzle({ client: pool });
