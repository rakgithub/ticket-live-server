import { pool } from "../db/client.ts";
import { createLogger } from "../observability/logger.ts";
import { startOutboxWorker } from "./outboxWorker.ts";

const stopOutboxWorker = startOutboxWorker();
const logger = createLogger("ticket-live-outbox-worker");

logger.info("Outbox worker started");

let isShuttingDown = false;

async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info("Outbox worker shutting down", { signal });

  await stopOutboxWorker();

  const results = await Promise.allSettled([pool.end()]);

  for (const result of results) {
    if (result.status === "rejected") {
      logger.error("Outbox worker shutdown failed", {
        errorType: result.reason instanceof Error ? result.reason.name : "UnknownError",
      });
      process.exitCode = 1;
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
