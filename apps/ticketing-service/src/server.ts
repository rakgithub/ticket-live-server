import express, { type ErrorRequestHandler } from "express";
import {
  HttpErrorSchema,
  InternalTicketQueryRequestSchema,
  TicketCheckInRequestSchema,
  TicketCheckInResponseSchema,
  TicketListResponseSchema,
} from "@ticket-live/contracts";
import {
  createLogger,
  env,
  exportOtlpMetrics,
  httpObservabilityMiddleware,
  renderHttpMetrics,
  requireInternalServiceAuth,
} from "@ticket-live/runtime";
import { pool } from "./db/client.ts";
import { startTicketingConsumer } from "./messaging/ticketingConsumer.ts";
import { checkInTicket, listTicketsForOrders, TicketCheckInError } from "./services/ticketService.ts";

const logger = createLogger("ticket-live-ticketing-service");
const app = express();
const consumer = startTicketingConsumer();

app.use(httpObservabilityMiddleware);
app.use(express.json({ limit: "100kb" }));
app.use("/internal", requireInternalServiceAuth);

app.post("/internal/tickets/query", async (req, res) => {
  const parsed = InternalTicketQueryRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid ticket query" });
    return;
  }
  const records = await listTicketsForOrders(parsed.data.orderIds);
  const tickets = records.map((ticket) => ({
    ...ticket,
    issuedAt: ticket.issuedAt.toISOString(),
    eventStartsAt: ticket.eventStartsAt.toISOString(),
    checkInAt: ticket.checkInAt?.toISOString() ?? null,
  }));
  res.json(TicketListResponseSchema.parse({ tickets }));
});

app.post("/internal/tickets/check-in", async (req, res) => {
  const parsed = TicketCheckInRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid ticket check-in request" });
    return;
  }

  try {
    const ticket = await checkInTicket(parsed.data);
    res.json(TicketCheckInResponseSchema.parse({
      ticket: {
        ...ticket,
        issuedAt: ticket.issuedAt.toISOString(),
        eventStartsAt: ticket.eventStartsAt.toISOString(),
        checkInAt: ticket.checkInAt?.toISOString() ?? null,
      },
    }));
  } catch (error) {
    if (error instanceof TicketCheckInError) {
      res.status(error.status).json(HttpErrorSchema.parse({ error: error.message }));
      return;
    }
    throw error;
  }
});

app.get("/health/live", (_req, res) => res.status(200).json({ status: "ok" }));
app.get("/health/ready", async (_req, res) => {
  const postgres = await pool.query("SELECT 1 FROM ticketing_service.tickets LIMIT 0").then(() => true, () => false);
  const rabbitmq = consumer.isReady();
  const ready = postgres && rabbitmq;
  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    checks: { postgres, rabbitmq },
  });
});

app.get("/metrics", (_req, res) => {
  exportOtlpMetrics(undefined, "ticket-live-ticketing-service");
  res.type("text/plain; version=0.0.4; charset=utf-8").send(renderHttpMetrics());
});

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  logger.error("Ticketing service request failed", {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  res.status(500).json({ error: "Internal server error" });
};
app.use(errorHandler);

const server = app.listen(env.TICKETING_SERVICE_PORT, () => {
  logger.info("Ticketing service listening", { port: env.TICKETING_SERVICE_PORT });
});

let isShuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    server.close(() => {
      void Promise.all([consumer.stop(), pool.end()]).catch((error) => {
        logger.error("Ticketing service shutdown failed", {
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        process.exitCode = 1;
      });
    });
  });
}
