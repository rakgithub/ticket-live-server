import { Router } from "express";
import {
  getInventoryHoldById,
  postConfirmInventoryHold,
  postInventoryHold,
  postReleaseInventoryHold,
} from "../controllers/events/inventoryHoldsController.ts";

const internalInventoryRoutes = Router();

internalInventoryRoutes.post("/events/:eventId/holds", postInventoryHold);
internalInventoryRoutes.post("/holds/:holdId/confirm", postConfirmInventoryHold);
internalInventoryRoutes.post("/holds/:holdId/release", postReleaseInventoryHold);
internalInventoryRoutes.get("/holds/:holdId", getInventoryHoldById);
internalInventoryRoutes.use((_req, res) => {
  res.status(404).json({ error: "Internal route not found" });
});

export default internalInventoryRoutes;
