import { Router } from "express";
import { cancelEventController, createEventController, deleteEventController, eventCards, eventSearchCandidates, listEvents, searchEventsController, updateEventController } from "../controllers/eventsController.ts";
import { confirmHold, createHold, getHold, releaseHold } from "../controllers/holdsController.ts";

const eventsRoutes = Router();
eventsRoutes.get("/internal/events", listEvents);
eventsRoutes.get("/internal/events/search", searchEventsController);
eventsRoutes.post("/internal/events", createEventController);
eventsRoutes.patch("/internal/events/:eventId", updateEventController);
eventsRoutes.post("/internal/events/:eventId/cancel", cancelEventController);
eventsRoutes.delete("/internal/events/:eventId", deleteEventController);
eventsRoutes.get("/internal/event-search", eventSearchCandidates);
eventsRoutes.get("/internal/event-cards", eventCards);
eventsRoutes.post("/internal/events/:eventId/holds", createHold);
eventsRoutes.post("/internal/holds/:holdId/confirm", confirmHold);
eventsRoutes.post("/internal/holds/:holdId/release", releaseHold);
eventsRoutes.get("/internal/holds/:holdId", getHold);
export default eventsRoutes;
