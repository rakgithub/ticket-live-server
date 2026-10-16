import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env, createLogger } from "@ticket-live/runtime";

const logger = createLogger("ticket-live-event-service");

export const pool = new Pool({
  connectionString: env.EVENT_SERVICE_DATABASE_URL,
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
