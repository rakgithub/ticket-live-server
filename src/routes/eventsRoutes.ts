import { Router } from "express";
import {
  getAllEvents,
  postEvent,
} from "../controllers/events/eventsController.ts";

const eventsRoutes = Router();

eventsRoutes.get("/", getAllEvents);
eventsRoutes.post("/", postEvent);

export default eventsRoutes;
