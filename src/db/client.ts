import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

export const pool = new Pool({
  connectionString,
  max: 5,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (error) => {
  console.error("Unexpected error from an idle PostgreSQL client", error);
});

export const db = drizzle({ client: pool });