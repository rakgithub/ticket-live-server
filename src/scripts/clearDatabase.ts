import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is missing from .env");
}

if (!stdin.isTTY || !stdout.isTTY) {
  throw new Error("This destructive script must be run in an interactive terminal.");
}

const database = new URL(databaseUrl);
console.log(`Database: ${database.hostname}${database.port ? `:${database.port}` : ""}${database.pathname}`);
console.log("This will delete all rows from every application table except users.");

const readline = createInterface({ input: stdin, output: stdout });
let confirmation: string;

try {
  confirmation = await readline.question('Type "DELETE ALL DATA" to continue: ');
} finally {
  readline.close();
}

if (confirmation !== "DELETE ALL DATA") {
  console.log("Cancelled. No records were deleted.");
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Delete dependent rows before their parents. Do not use CASCADE: users must remain untouched.
    const tables = [
      "payments",
      "email_deliveries",
      "orders",
      "events",
      "revoked_access_tokens",
      "outbox_events",
    ];

    for (const table of tables) {
      const result = await client.query(`DELETE FROM ${table}`);
      console.log(`${table}: deleted ${result.rowCount ?? 0} row(s)`);
    }

    await client.query("COMMIT");
    console.log("Database cleared. The users table was left unchanged.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
