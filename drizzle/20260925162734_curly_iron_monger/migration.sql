CREATE TABLE "revoked_access_tokens" (
	"token_id" text PRIMARY KEY,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "revoked_access_tokens_expires_at_idx" ON "revoked_access_tokens" ("expires_at");