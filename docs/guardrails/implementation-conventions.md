## Implementation

- Keep changes focused and follow existing patterns and service ownership boundaries.
- Follow the approved plan; resolve minor details independently. If a consequential
  issue requires changing the plan, ask before proceeding.
- Obtain approval before introducing infrastructure, dependencies, or
  client-visible behavior.
- For API or message changes, update the relevant Zod schemas and matching
  OpenAPI or AsyncAPI documentation. Preserve compatibility with versioned messages.
- For database changes, update the owning service's Drizzle models and add a
  reviewed migration under `drizzle/`. Use `MIGRATION_DATABASE_URL` for migrations.
  Do not clear databases, reset volumes, or apply destructive migrations without
  explicit approval.
- Preserve checkout idempotency, capacity checks, order and payment state
  transitions, and transactional outbox behavior.
- Read affected service and worker paths before changing cross-service flows.
  Keep secrets and customer data out of logs.