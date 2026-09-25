import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../config/env.ts";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (error) => {
  console.error("Unexpected error from an idle PostgreSQL client", error);
});

export const db = drizzle({ client: pool });
