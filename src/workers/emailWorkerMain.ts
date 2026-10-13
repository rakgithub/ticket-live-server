import { pool } from "../db/client.ts";
import { createLogger } from "../observability/logger.ts";
import { startEmailWorker } from "./emailWorker.ts";

const logger = createLogger("ticket-live-email-worker");
const stopEmailWorker = await startEmailWorker();
const keepAlive = setInterval(() => undefined, 60_000);

logger.info("Email worker started in simulated-delivery mode");

let isShuttingDown = false;

async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info("Email worker shutting down", { signal });

  try {
    clearInterval(keepAlive);
    await stopEmailWorker();
    await pool.end();
  } catch (error) {
    logger.error("Email worker shutdown failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    process.exitCode = 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
