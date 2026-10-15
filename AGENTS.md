# Agent guide

## Start here

- Read `README.md` for local setup and current behavior.

- This is a pnpm 11 workspace. The running Express API and workers still live in `src/`. `apps/public-api` is a launch alias; the other `apps/*` workspaces are being filled incrementally. `packages/contracts` holds shared wire contracts, not business logic or Drizzle models.
- Before editing, check `git status` and nearby code. Preserve existing local changes and follow the conventions of the files you touch.

## Working in this repo

- Keep changes focused. Ask the user before a large change or a client-visible contract change. Do not implement migration-plan phases merely because they are described in docs.
- For API or message changes, update the relevant Zod schemas in `packages/contracts/src/` and the matching OpenAPI or AsyncAPI files in `docs/contracts/`. Keep producers and consumers compatible with existing versioned messages.
- For database changes, update the owning models in `src/db/schema/` and add a reviewed Drizzle migration under `drizzle/`. Use `MIGRATION_DATABASE_URL` for migrations. Do not run `db:clear`, reset volumes, or apply destructive migrations without explicit approval.
- Preserve checkout idempotency, capacity checks, order/payment state transitions, and transactional outbox behavior. Keep secrets and customer data out of logs. Read the affected service and worker paths before changing a cross-boundary flow.

## Commands and verification

- Install dependencies: `pnpm install`. Local infrastructure and startup steps are in `README.md`.
- API: `pnpm start`; outbox worker: `pnpm start:worker`; email worker: `pnpm start:email-worker`.
- Database migrations: `pnpm exec drizzle-kit migrate` after reviewing the generated SQL and confirming the target database.
- There is no configured test suite: `pnpm test` is a placeholder that exits with an error. Verify focused changes with appropriate checks and report what ran and what could not be checked.

## Finish

- Keep explanations concise. Report what changed, what was verified, and any material limitation.
