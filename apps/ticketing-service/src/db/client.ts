import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createLogger, env } from "@ticket-live/runtime";

const logger = createLogger("ticket-live-ticketing-service");

export const pool = new Pool({
  connectionString: env.TICKETING_SERVICE_DATABASE_URL,
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
