import { ipKeyGenerator, rateLimit } from "express-rate-limit";

export const eventChatRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.auth?.userId ?? ipKeyGenerator(req.ip ?? "unknown"),
  message: { error: "Too many chat requests. Try again shortly." },
});
