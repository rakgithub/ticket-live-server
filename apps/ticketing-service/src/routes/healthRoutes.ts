import { Router } from "express";
import { createReadinessController, getLiveness, getMetrics } from "../controllers/healthController.ts";
export function createHealthRoutes(isConsumerReady: () => boolean) {
  const healthRoutes = Router();
  healthRoutes.get("/health/live", getLiveness);
  healthRoutes.get("/health/ready", createReadinessController(isConsumerReady));
  healthRoutes.get("/metrics", getMetrics);
  return healthRoutes;
}
