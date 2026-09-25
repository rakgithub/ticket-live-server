import { jwtVerify } from "jose";
import type { RequestHandler } from "express";
import { env } from "../config/env.ts";
import { isAccessTokenRevoked } from "../services/auth/logoutService.ts";

const verificationKey = new TextEncoder().encode(env.JWT_SECRET);

export const requireAuth: RequestHandler = async (req, res, next) => {
  const authorization = req.header("authorization");
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);

  if (!match) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  let userId: string;
  let tokenId: string;
  let expiresAt: Date;
  try {
    const { payload } = await jwtVerify(match[1], verificationKey, {
      algorithms: ["HS256"],
      issuer: "ticket-live-api",
      audience: "ticket-live-client",
    });

    if (!payload.sub || !payload.jti || !payload.exp) {
      res.status(401).json({ error: "Invalid or expired access token" });
      return;
    }

    userId = payload.sub;
    tokenId = payload.jti;
    expiresAt = new Date(payload.exp * 1_000);
  } catch {
    res.status(401).json({ error: "Invalid or expired access token" });
    return;
  }

  if (await isAccessTokenRevoked(tokenId)) {
    res.status(401).json({ error: "Invalid or expired access token" });
    return;
  }

  req.auth = { userId, tokenId, expiresAt };
  next();
};
