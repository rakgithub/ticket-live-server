import { Router } from "express";
import {
  getAllEvents,
  getSearchEvents,
  postEvent,
} from "../controllers/events/eventsController.ts";

const eventsRoutes = Router();

eventsRoutes.get("/", getAllEvents);
eventsRoutes.get("/search", getSearchEvents);
eventsRoutes.post("/", postEvent);

export default eventsRoutes;
