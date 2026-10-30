import type { Request, Response } from "express";
import { renderHttpMetrics, exportOtlpMetrics } from "@ticket-live/runtime";
import { pool } from "../db/client.ts";
import { getEventServiceClient } from "../clients/eventServiceClient.ts";
import { getOrderServiceClient } from "../clients/orderServiceClient.ts";
import { getTicketingServiceClient } from "../clients/ticketingServiceClient.ts";
import { renderEventChatMetrics } from "../chat/eventChatMetrics.ts";

export function getLiveness(_req: Request, res: Response): void {
  res.status(200).json({ status: "ok" });
}

export async function getReadiness(_req: Request, res: Response): Promise<void> {
  const [postgres, eventService, orderService, ticketingService] = await Promise.allSettled([
    pool.query("SELECT 1"),
    getEventServiceClient().readiness(),
    getOrderServiceClient().readiness(),
    getTicketingServiceClient().readiness(),
  ]);
  const checks = {
    postgres: postgres.status === "fulfilled",
    eventService: eventService.status === "fulfilled" && eventService.value.status === "ready",
    orderService: orderService.status === "fulfilled" && orderService.value,
    ticketingService: ticketingService.status === "fulfilled" && ticketingService.value,
  };
  const ready = checks.postgres && checks.eventService && checks.orderService && checks.ticketingService;

  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    checks,
  });
}

export async function getMetrics(_req: Request, res: Response): Promise<void> {
  exportOtlpMetrics();
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.status(200).send(`${renderHttpMetrics()}${renderEventChatMetrics()}`);
}
