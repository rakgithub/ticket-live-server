import type { Request, Response } from "express";
import { exportOtlpMetrics, renderHttpMetrics } from "@ticket-live/runtime";

export function getLiveness(_req: Request, res: Response): void {
  res.status(200).json({ status: "ok" });
}

export function getReadiness(_req: Request, res: Response): void {
  res.status(200).json({ status: "ready" });
}

export function getMetrics(_req: Request, res: Response): void {
  exportOtlpMetrics(undefined, "ticket-live-analytics-service");
  res.type("text/plain; version=0.0.4; charset=utf-8").send(renderHttpMetrics());
}
