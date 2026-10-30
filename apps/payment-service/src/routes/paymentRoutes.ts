import { Router } from "express";
import { getPayment, postPayment, postPaymentCancellation } from "../controllers/paymentController.ts";
const paymentRoutes = Router();
paymentRoutes.post("/internal/payments", postPayment);
paymentRoutes.get("/internal/payments/:orderId", getPayment);
paymentRoutes.post("/internal/payments/:orderId/cancel", postPaymentCancellation);
export default paymentRoutes;
