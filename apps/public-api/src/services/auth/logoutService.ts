import { eq } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { revokedAccessTokensTable } from "../../db/schema/revokedAccessTokens.ts";

export async function isAccessTokenRevoked(tokenId: string): Promise<boolean> {
  const [revokedToken] = await db
    .select({ tokenId: revokedAccessTokensTable.tokenId })
    .from(revokedAccessTokensTable)
    .where(eq(revokedAccessTokensTable.tokenId, tokenId))
    .limit(1);

  return Boolean(revokedToken);
}

export async function revokeAccessToken(
  tokenId: string,
  expiresAt: Date,
): Promise<void> {
  await db
    .insert(revokedAccessTokensTable)
    .values({ tokenId, expiresAt })
    .onConflictDoNothing();
}
