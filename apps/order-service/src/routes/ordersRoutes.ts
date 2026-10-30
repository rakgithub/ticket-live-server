import { Router } from "express";
import { getOrders, postCheckout } from "../controllers/ordersController.ts";

const ordersRoutes = Router();

ordersRoutes.get("/internal/orders", getOrders);
ordersRoutes.post("/internal/orders/checkout", postCheckout);

export default ordersRoutes;
