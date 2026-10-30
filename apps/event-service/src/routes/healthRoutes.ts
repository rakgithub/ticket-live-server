import { Router } from "express";
import { getLiveness, getMetrics, getReadiness } from "../controllers/healthController.ts";
const healthRoutes = Router();
healthRoutes.get("/health/live", getLiveness);
healthRoutes.get("/health/ready", getReadiness);
healthRoutes.get("/metrics", getMetrics);
export default healthRoutes;
