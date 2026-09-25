import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const revokedAccessTokensTable = pgTable(
  "revoked_access_tokens",
  {
    tokenId: text("token_id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("revoked_access_tokens_expires_at_idx").on(table.expiresAt)],
);
