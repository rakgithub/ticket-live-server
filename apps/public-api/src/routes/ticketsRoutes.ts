import { Router } from "express";
import { getTickets } from "../controllers/tickets/ticketsController.ts";

const ticketsRoutes = Router();
ticketsRoutes.get("/", getTickets);

export default ticketsRoutes;
