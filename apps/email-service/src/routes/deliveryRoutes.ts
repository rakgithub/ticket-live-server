import { Router } from "express";
import { getDelivery } from "../controllers/deliveryController.ts";
const deliveryRoutes = Router();
deliveryRoutes.get("/internal/deliveries/:notificationKey", getDelivery);
export default deliveryRoutes;
