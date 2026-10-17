import { Router } from "express";
import { getOrders, postCheckout } from "../controllers/orders/ordersController.ts";

const ordersRoutes = Router();

ordersRoutes.get("/", getOrders);
ordersRoutes.post("/checkout", postCheckout);

export default ordersRoutes;
