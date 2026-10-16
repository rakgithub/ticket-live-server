import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../config/env.ts";
import { createLogger } from "../observability/logger.ts";

const logger = createLogger(
  env.TICKETLIVE_SERVICE === "event"
    ? "ticket-live-event-service"
    : env.TICKETLIVE_SERVICE === "email"
      ? "ticket-live-email-service"
      : "ticket-live-public-api",
);

export const pool = new Pool({
  connectionString: env.TICKETLIVE_SERVICE === "event"
    ? env.EVENT_SERVICE_DATABASE_URL
    : env.TICKETLIVE_SERVICE === "email"
      ? env.EMAIL_SERVICE_DATABASE_URL
      : env.DATABASE_URL,
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
