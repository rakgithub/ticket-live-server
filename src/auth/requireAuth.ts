import { jwtVerify } from "jose";
import type { RequestHandler } from "express";
import { env } from "../config/env.ts";

const verificationKey = new TextEncoder().encode(env.JWT_SECRET);

export const requireAuth: RequestHandler = async (req, res, next) => {
  const authorization = req.header("authorization");
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);

  if (!match) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  let userId: string;
  try {
    const { payload } = await jwtVerify(match[1], verificationKey, {
      algorithms: ["HS256"],
      issuer: "ticket-live-api",
      audience: "ticket-live-client",
    });

    if (!payload.sub) {
      res.status(401).json({ error: "Invalid or expired access token" });
      return;
    }
    userId = payload.sub;
  } catch {
    res.status(401).json({ error: "Invalid or expired access token" });
    return;
  }

  req.auth = { userId };
  next();
};
