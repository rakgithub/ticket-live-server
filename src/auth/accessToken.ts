import { SignJWT } from "jose";
import { env } from "../config/env.ts";

const signingKey = new TextEncoder().encode(env.JWT_SECRET);

export async function createAccessToken(userId: string): Promise<string> {
  return new SignJWT()
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuedAt()
    .setIssuer("ticket-live-api")
    .setAudience("ticket-live-client")
    .setExpirationTime(env.ACCESS_TOKEN_TTL)
    .sign(signingKey);
}
