import { Router } from "express";
import { postCheckout } from "../controllers/orders/ordersController.ts";

const ordersRoutes = Router();

ordersRoutes.post("/checkout", postCheckout);

export default ordersRoutes;
