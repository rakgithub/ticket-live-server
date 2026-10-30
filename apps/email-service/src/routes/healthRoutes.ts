import { Router } from "express";
import { createHealthController, getLiveness, getMetrics } from "../controllers/healthController.ts";

export function createHealthRoutes(isWorkerReady: () => boolean) {
  const healthRoutes = Router();
  healthRoutes.get("/metrics", getMetrics);
  healthRoutes.get("/health/live", getLiveness);
  healthRoutes.get("/health/ready", createHealthController(isWorkerReady));
  return healthRoutes;
}
