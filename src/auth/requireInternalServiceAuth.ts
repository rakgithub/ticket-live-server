import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env } from "../config/env.ts";

export const requireInternalServiceAuth: RequestHandler = (req, res, next) => {
  const expectedToken = env.INTERNAL_SERVICE_TOKEN;
  if (!expectedToken) {
    res.status(503).json({ error: "Internal service authentication is not configured" });
    return;
  }

  const match = req.header("authorization")?.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) {
    res.status(401).json({ error: "Service authentication required" });
    return;
  }

  const received = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    res.status(401).json({ error: "Invalid service credentials" });
    return;
  }

  next();
};
