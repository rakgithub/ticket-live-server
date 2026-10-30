import { Router } from "express";
import { checkIn, queryTickets } from "../controllers/ticketController.ts";
const ticketRoutes = Router();
ticketRoutes.post("/internal/tickets/query", queryTickets);
ticketRoutes.post("/internal/tickets/check-in", checkIn);
export default ticketRoutes;
