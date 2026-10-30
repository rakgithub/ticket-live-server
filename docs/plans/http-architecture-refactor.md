# HTTP architecture refactor plan

## Goal and boundaries

Give every app the same HTTP layering: `server.ts` configures middleware, mounts routes, registers error middleware, and owns startup and shutdown; `routes/` maps HTTP methods and paths to handlers; `controllers/` validate requests, invoke services, serialize responses, and retain existing handler-level expected-error mappings; services retain business logic. Keep existing middleware-level error mappings in middleware, including their logging and propagation behavior. Health and metrics endpoints follow the same route/controller split. Use the public API's existing router pattern. Keep app-specific controllers local; do not add a shared framework or dependency.

This is a behavior-preserving refactor. Preserve method, path, registration order, authentication, input validation, response status/body/headers, log behavior, metrics, and lifecycle. Do not change contracts, database schema, service workflows, or message formats. Keep `main.ts` environment selection before loading server modules. Extract error middleware where useful, but register it after routes. Avoid starting workers or listeners on importing controllers or routers. Where readiness depends on a running worker, inject a readiness function into the controller/router factory from `server.ts`.

For newly extracted internal-service routers, mount at the application root and retain the existing full route paths by default. Keep `/internal` authentication registered separately before those routers. Preserve existing public API mount prefixes. Verify observability at response completion: `httpObservabilityMiddleware` derives metric labels, trace attributes, and logged routes from `req.baseUrl` and `req.route.path`, so matching the external URL alone does not prove equivalence. Keep route parameters in the router's own path; if a parameter is placed in a parent mount, explicitly forward it with `Router({ mergeParams: true })` and test that the controller receives it.

Retain the current startup contract: `main.ts` selects the service environment and dynamically imports `server.ts`, which starts the app. Server tests must mock listener, worker, timer, signal, database, and external-service boundaries as applicable before importing the server; do not introduce a new startup API solely for this refactor. Importing routers or controllers must not start listeners, workers, or lifecycle timers. Isolate module state and restore signal handlers and mocks between tests. The shared Vitest setup selects `public-api`; service-specific tests must select the appropriate service before importing environment-dependent modules and avoid reusing configuration cached for another service.

## Phase order and completion

Implement phases 1–7 sequentially in the order below. Each phase is scoped to one app and its dedicated tests; no coordinated cross-service rollout or contract change is required. Apply the shared implementation and verification requirements below to every phase: establish the app's baseline tests before extraction, add module tests during extraction, then verify equivalence before proceeding. Record completed work, check results, and any limitations at the end of each phase.

## Phase 1: Public API

- Existing auth, events, orders, tickets, and chat routers already call controllers. Retain their paths and route-specific rate limits.
- Move the three inline handlers in `routes/healthRoutes.ts` to a health controller; leave only mappings in the router. Preserve PostgreSQL and event/order/ticketing readiness checks, `Promise.allSettled`, response shapes, OTLP export, and concatenated chat metrics.
- Preserve server order: trust proxy, helmet, CORS, observability, JSON parser, health, auth routes, `requireAuth`, protected routes, 404, error handler. Preserve logout's own authentication, headers-sent handling, status mapping, server close and pool cleanup.

Completion gate: health and metrics handlers live in the controller; existing application routers remain behaviorally unchanged. Tests verify readiness dependency outcomes, metrics concatenation, authentication and rate-limit placement, error behavior, observability, and guarded server/pool shutdown.

## Phase 2: Order service

- Add orders router and controller for `GET /internal/orders` and `POST /internal/orders/checkout`. Move UUID, body and idempotency-key validation and `CheckoutError`/response schema handling unchanged. Keep calls to `listOrdersForUser` and `checkout` in the service layer.
- Add health and metrics routes/controllers. Preserve PostgreSQL readiness and the independent outbox and unresolved-order metric queries, their failure handling, mismatch counter, and OTLP export.
- Keep `/internal` service authentication before internal routes. Keep outbox worker startup, listening, shutdown guard, worker stop followed by pool close, and error logging in server lifecycle.

Completion gate: order, health, and metrics handlers use routers/controllers. Tests verify checkout validation and error mapping, internal authentication, independent metrics-query failures, and worker startup and stop-before-pool-close ordering.

## Phase 3: Event service

- Add event and inventory-hold routers/controllers for event listing, search, creation, update, cancellation and deletion; event-search candidates and event cards; hold creation, confirmation, release and lookup. Preserve route order, including `/internal/events/search`, and all actor, UUID, query, body and idempotency validation.
- Move event schemas and event/hold serializers alongside the relevant controller or into focused HTTP helpers. Preserve normalization, dates, currency trimming, response schemas, empty update rejection, hold key matching and 201/200 behavior.
- Add health and metrics controllers/routes. Preserve concurrent PostgreSQL/Elasticsearch readiness with its timeout, outbox and active-hold queries, counters and fallback behavior.
- Preserve middleware error mappings for `EventUpdateError`, `InventoryHoldError`, and `EventSearchUnavailableError`. Keep expiry and outbox timers, immediate outbox run, unref calls and existing shutdown operations in server lifecycle.

Completion gate: event, search, card, hold, health, and metrics handlers use routers/controllers. Tests verify all route parameters and mappings, normalization and serialization, hold idempotency validation and response statuses, middleware error mappings, readiness timeout configuration, metrics fallback, and timer/outbox startup and cleanup.

## Phase 4: Payment service

- Add payment routes/controller for charge, lookup, and cancel. Preserve request schemas, UUID validation, missing-payment 404, differing-amount 409 mapping, and payment response parsing.
- Extract health and metrics handlers; retain PostgreSQL readiness, OTLP export and metrics content type. Keep internal authentication and generic error middleware ordering, and guarded server/pool shutdown.

Completion gate: payment, health, and metrics handlers use routers/controllers. Tests verify charge/lookup/cancel mappings, validation, missing-payment and differing-amount responses, internal authentication, readiness and metrics, and guarded shutdown.

## Phase 5: Ticketing service

- Add ticket routes/controller for query and check-in. Preserve validation, date serialization, response schemas, and `TicketCheckInError` status mapping.
- Extract health and metrics handlers. Pass a readiness callback from the server's existing consumer to the readiness controller; retain the exact PostgreSQL probe and RabbitMQ checks. Keep consumer startup and parallel consumer/pool shutdown in server lifecycle.

Completion gate: ticket, health, and metrics handlers use routers/controllers. Tests verify query/check-in contracts and dates, check-in error mapping, internal authentication, changing consumer readiness through the injected callback, the exact PostgreSQL probe, and parallel consumer/pool shutdown.

## Phase 6: Email service

- Add delivery router/controller for `GET /internal/deliveries/:notificationKey`. Preserve key trimming and limits, 404, response schema and timestamp serialization.
- Extract health and metrics handlers. Inject the existing worker readiness callback; preserve PostgreSQL probe, RabbitMQ readiness, metrics query/rendering, and the 503 text response on metrics failure.
- Keep worker startup and guarded shutdown (worker stop then pool close) in server lifecycle; retain service authentication and error handler ordering.

Completion gate: delivery, health, and metrics handlers use routers/controllers. Tests verify notification-key validation, missing deliveries and timestamp serialization, internal authentication, changing worker readiness through the injected callback, metrics success and 503/logging behavior, and worker stop before pool close.

## Phase 7: Analytics service

- Add health and metrics router/controller for the two health endpoints and `/metrics`. Preserve the current unconditional readiness response, OTLP export and metrics content type.
- Keep observability and JSON middleware, listener and signal-driven close in `server.ts`; avoid inventing dependencies or readiness checks.

Completion gate: health and metrics handlers use routers/controllers. Tests verify unchanged liveness/readiness bodies, metrics export and content type, middleware placement, listener startup, and the existing signal-driven close behavior. Complete the final cross-app acceptance check below.

## Shared implementation and verification requirements

1. Inventory each current endpoint, mount prefix, middleware order, observability route value, and lifecycle sequence against this plan. Before extracting each app, add behavior tests against its existing server with external and lifecycle boundaries mocked. Cover successful requests, validation, authentication, malformed JSON, unmatched routes, expected and unexpected errors, health and metrics failures, route labels/logging, and startup/shutdown ordering as applicable. Preserve existing behavior even where it differs between apps; record unrelated defects separately. Run these tests against the original composition and keep them passing through extraction.
2. Extract one app at a time, keeping route paths and response behavior intact. Wire worker readiness through explicit callbacks rather than starting workers in HTTP modules. Add a dedicated co-located `<module>.test.ts` for every production source file created or changed, including each controller, router, extracted middleware or helper, and each `server.ts`. Retain the server behavior tests from step 1 alongside the new module tests. A test that exercises a file only through another module does not replace its own dedicated test. Declaration-only or generated files require a dedicated type or build contract check instead of an artificial runtime test.
   - Controller tests directly cover valid and invalid input, service calls and failures, status codes, response schemas, serialization, health dependency failures, and metrics fallback as applicable.
   - Router tests directly cover method/path mappings, parameter forwarding, and relevant route-specific middleware. Server tests cover authentication boundaries, middleware and router ordering, observability route values at response completion, startup, shutdown, and resource cleanup. Exercise requests through Express with boundary mocks rather than relying only on registration-call assertions. Verify that importing controllers and routers does not start listeners, workers, or lifecycle timers; test server startup through mocked boundaries under the existing import contract.
   - Helper and middleware tests directly cover their observable behavior and error cases. Use deterministic fixtures and boundary mocks; avoid real credentials, external network calls, shared state, arbitrary delays, and test-order dependencies. Use an isolated real database if database constraints or transactions are relevant.
3. At the end of every app phase, run its focused tests, then `pnpm lint`, `pnpm typecheck`, and `pnpm test`. Compare routes, middleware order, observability, startup and shutdown with that app's baseline. Satisfy its completion gate and report failures and unavailable checks before proceeding to the next phase.
4. Final acceptance after phase 7: all seven apps use routers and controllers for endpoint handlers; `server.ts` owns application composition and lifecycle; no endpoint or operational behavior changes; every created or changed production file has its own dedicated test or applicable type/build contract check; every phase's completion gate is satisfied; required checks pass or limitations are reported.
