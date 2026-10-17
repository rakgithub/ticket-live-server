import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env, serviceCredential, type InternalCredential } from "../config/env.ts";

function expectedCredentials(req: Parameters<RequestHandler>[0]): string[] {
  let names: InternalCredential[];
  if (env.TICKETLIVE_SERVICE === "event") {
    const inventoryPath = /^\/events\/[^/]+\/holds$/.test(req.path) ||
      /^\/holds\/[^/]+(?:\/(?:confirm|release))?$/.test(req.path);
    names = [inventoryPath ? "order-event" : "public-api-event"];
  } else if (env.TICKETLIVE_SERVICE === "order") {
    names = ["public-api-order"];
  } else if (env.TICKETLIVE_SERVICE === "email") {
    names = ["email-internal"];
  } else if (env.TICKETLIVE_SERVICE === "payment") {
    names = ["order-payment"];
  } else if (env.TICKETLIVE_SERVICE === "ticketing") {
    names = [req.path === "/tickets/check-in" ? "ticketing-check-in" : "public-api-ticketing"];
  } else {
    names = [];
  }
  return names.map((name) => serviceCredential(name)).filter((value): value is string => Boolean(value));
}

export const requireInternalServiceAuth: RequestHandler = (req, res, next) => {
  const credentials = expectedCredentials(req);
  if (credentials.length === 0) {
    res.status(503).json({ error: "Internal service authentication is not configured" });
    return;
  }

  const match = req.header("authorization")?.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) {
    res.status(401).json({ error: "Service authentication required" });
    return;
  }

  const received = Buffer.from(match[1]);
  const authorized = credentials.some((credential) => {
    const expected = Buffer.from(credential);
    return received.length === expected.length && timingSafeEqual(received, expected);
  });
  if (!authorized) {
    res.status(401).json({ error: "Invalid service credentials" });
    return;
  }

  next();
};
