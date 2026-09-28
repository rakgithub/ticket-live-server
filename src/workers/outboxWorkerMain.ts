import { pool } from "../db/client.ts";
import { elasticsearch } from "../search/client.ts";
import { startOutboxWorker } from "./outboxWorker.ts";

const stopOutboxWorker = startOutboxWorker();

console.log("Outbox worker started");

let isShuttingDown = false;

async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}; shutting down outbox worker`);

  await stopOutboxWorker();

  const results = await Promise.allSettled([
    pool.end(),
    elasticsearch.close(),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Outbox worker shutdown failed", result.reason);
      process.exitCode = 1;
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
