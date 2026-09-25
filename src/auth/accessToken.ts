import { SignJWT } from "jose";

const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  throw new Error("JWT_SECRET is required");
}

const signingKey = new TextEncoder().encode(jwtSecret);

if (signingKey.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 bytes");
}

const accessTokenTtl = process.env.ACCESS_TOKEN_TTL ?? "15m";

export async function createAccessToken(userId: string): Promise<string> {
  return new SignJWT()
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(accessTokenTtl)
    .sign(signingKey);
}
