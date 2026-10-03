import { Router } from "express";
import { streamEventSearch } from "../controllers/chat/chatController.ts";
import { eventChatRateLimit } from "../chat/chatRateLimit.ts";

const chatRoutes = Router();

chatRoutes.post("/events/stream", eventChatRateLimit, streamEventSearch);

export default chatRoutes;
