# Ticket live engineering guide

Ticket Live is a Node.js and TypeScript backend for discovering events and booking tickets. Its services manage event inventory, checkout, payments, ticket issuance, and confirmation delivery.

## Repository layout
- This is a pnpm 11 workspace.
- `apps/` contains the public API and the Event, Order, Payment, Ticketing, Email, and Analytics services.
- `packages/contracts/` contains shared wire contracts; `packages/runtime/` contains shared runtime utilities.
- `docs/` contains architecture and contract documentation; `drizzle/` contains database migrations.

Read the relevant convention files before planning, implementing, testing, or verifying a change.

## TypeScript Conventions
Reference `docs/guardrails/typescript-conventions.md` for detailed typescript conventions

## Planning conventions
Reference `docs/guardrails/planning-conventions.md` for detailed planning conventions

## Implementation Conventions
Reference `docs/guardrails/implementation-conventions.md` for detailed implementation conventions

## Testing Conventions
Reference `docs/guardrails/testing-conventions.md` for detailed testing conventions

## Verification Conventions
Reference `docs/guardrails/verification-conventions.md` for detailed verification conventions
