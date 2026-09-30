import { pool } from "../db/client.ts";
import { startEmailWorker } from "./emailWorker.ts";

const stopEmailWorker = await startEmailWorker();
const keepAlive = setInterval(() => undefined, 60_000);

console.log("Email worker started in simulated-delivery mode");

let isShuttingDown = false;

async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}; shutting down email worker`);

  try {
    clearInterval(keepAlive);
    await stopEmailWorker();
    await pool.end();
  } catch (error) {
    console.error("Email worker shutdown failed", error);
    process.exitCode = 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
