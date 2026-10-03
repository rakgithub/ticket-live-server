# Event discovery chat: phased implementation plan

Status: phase 1 backend implemented; production rollout still needs provider configuration, frontend integration, and the listed operational checks. Scope for the first release is **natural-language event search with a progressively displayed response and structured event cards**. FAQs, live availability, and guided follow-up questions are later phases.

## 1. Decision and boundaries

Build the first release in the existing Node/TypeScript Express API. Use a small **LangGraph JavaScript** graph now because guided follow-ups and additional data sources are planned, but keep all business rules and queries in ordinary typed services. The graph coordinates steps; it does not own HTTP, authorization, SQL, Elasticsearch query construction, or UI rendering.

Implementation choice: use `@langchain/langgraph` with the official `@google/genai` SDK, configured by `GEMINI_API_KEY` and `EVENT_CHAT_MODEL` (default `gemini-3.8-flash`). The key is optional for server startup; the endpoint returns `503` until configured. The endpoint has an in-process rate limit and per-user concurrent-stream cap; use a shared limiter before scaling to multiple API processes.

Use one authenticated `POST /chat/events/stream` request and one streaming HTTP response. The browser sends a user message with `fetch()` and renders server-sent-event (SSE) frames from the response body. The backend sends structured search results as soon as they are verified, followed by optional streamed assistant text. The cards remain authoritative UI data; model prose never supplies event IDs, prices, or links.

Do not add a vector database, RabbitMQ job, WebSocket server, or separate LangGraph deployment for this flow. RabbitMQ in this repository handles background order confirmation, while this request needs an immediate answer on the same connection. Reassess infrastructure when measured load or new capabilities justify it.

### Current repository facts

| Area | Existing implementation | Consequence |
| --- | --- | --- |
| HTTP | `src/server.ts`, Express 5, `express.json({ limit: "100kb" })` | Add a protected route and handle errors after streaming starts. |
| Auth | `src/auth/requireAuth.ts` is global below auth routes | Chat inherits JWT auth; use `req.auth.userId` for limits and future conversation ownership. |
| Search | `src/services/events/eventsSearchService.ts` uses Elasticsearch `multi_match` with `operator: "and"` across name, description, location | Refactor into typed search criteria. Passing the raw sentence “events in Berlin” as `q` is unreliable. |
| Index | `src/search/eventsIndex.ts`, created through the outbox worker | Search is eventually consistent. The present worker indexes `event.created`; updates, cancellation, and deletion are not covered by the visible index path. |
| Truth | `src/db/schema/events.ts` in PostgreSQL | Re-read search hits by ID before returning cards; enforce visibility and current status there. |
| Validation | Zod v4 already installed | Validate HTTP input, interpreted criteria, internal events, and public cards. |
| Rate limits | Login-only limiter in `src/auth/loginRateLimit.ts` | Add a separate chat limiter and active-stream cap. |
| Frontend | No frontend project in this repository | Specify a client contract and example behavior; implement UI in its own repo. |
| Tests | No test runner or test suite configured in `package.json` | Add focused tests for query construction, parsing, streaming, and disconnect behavior. |

## 2. Target behavior for phase 1

Examples:

- “Events in Berlin” extracts `location = Berlin`, finds upcoming active events, streams cards, and displays “Here are some upcoming events in Berlin.”
- “Jazz in Berlin” extracts `text = jazz`, `location = Berlin` and returns matching cards.
- “Show me events” searches upcoming events without a text term, with a conservative result limit.
- No matches produce an explicit empty result and a short suggestion to broaden the search.
- Requests about FAQs, ticket availability, or booking are recognized as outside phase 1 and receive a scoped response; the model must not invent those answers.

The first release is **single turn**. Do not imply that “show me more” or “only comedy” will remember a previous request until conversation state is introduced. The public protocol should carry an optional future `conversationId`, but phase 1 must either reject it or ignore it explicitly and document that behavior. Do not silently claim conversation continuity.

### Latency expectation

The search has to complete before factual cards can be sent. Send a `status` frame promptly after validation, then a `results` frame immediately after PostgreSQL hydration. Stream any model-generated summary after `results`; never delay cards to wait for prose. Track time to first byte, time to results, time to first text delta, and total request duration. Set targets only after a baseline measurement in the deployment environment.

## 3. Phase 0 — contract, data audit, and transport spike

1. Decide and document public event visibility: which events may be shown, whether past events appear, and whether a cancelled event should appear in historical queries. Phase 1 default: upcoming, not cancelled, not soft-deleted.
2. Confirm the product timezone rule. Store and compare instants in UTC; display event-local time only if a reliable IANA timezone or venue timezone is available. The existing schema has `startsAt` and a free-text `location`, but no timezone field. Avoid guessing event-local timezone from location text.
3. Confirm whether event descriptions can contain private organizer content. Send only public fields to the model.
4. Exercise a small local `POST` SSE stream through the actual development proxy/browser path. Verify incremental delivery, CORS `Authorization` preflight, client abort, proxy buffering, and idle timeout. Record any proxy configuration needed before implementing the graph.
5. Select the model provider and pin an explicit model identifier in environment configuration. Check current provider SDK and LangGraph version documentation before installing; avoid a floating `latest` model alias. Keep the provider API key server side.
6. Set a response contract version, e.g. `event-chat.v1`, and agree on event names with the frontend owner.

**Exit gate:** a client can read incremental frames from one authenticated POST request in the intended hosting path; product rules for visible events and timezone are written down.

## 4. Phase 1 — search and progressive list

### 4.1 API contract

Proposed endpoint:

```http
POST /chat/events/stream
Authorization: Bearer <access-token>
Content-Type: application/json
Accept: text/event-stream

{"message":"Jazz events in Berlin","limit":5}
```

Validate with Zod: trimmed nonempty `message` (suggested maximum 500 characters), integer `limit` (default 5, max 10), and no unknown public fields. Return ordinary JSON errors with appropriate 4xx/5xx status **before** writing stream headers for auth, validation, rate limit, and other preflight failures. For runtime failures **after** headers are sent, emit an `error` frame and end the stream. Do not call the current JSON error handler after writing stream headers.

Response headers: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, and appropriate connection/proxy buffering settings for the deployment. Flush headers if supported. Avoid compression or buffering that holds frames. Keep connection timeouts explicit and send a heartbeat comment only if the infrastructure requires it.

Frames are UTF-8 SSE (`event: <name>\ndata: <one JSON object>\n\n`). Contract example:

```text
event: status
data: {"requestId":"...","phase":"searching"}

event: results
data: {"requestId":"...","events":[{"id":"...","name":"...","location":"Berlin","startsAt":"2026-11-10T19:00:00.000Z","ticketPriceCents":2500,"currencyCode":"EUR","descriptionPreview":"..."}],"count":1}

event: delta
data: {"requestId":"...","text":"I found one upcoming event in Berlin."}

event: done
data: {"requestId":"...","finishReason":"completed"}

```

Possible `finishReason` values: `completed`, `empty`, `unsupported`. Use `event: error` with a stable public error code and `requestId` for post-header errors. Never put exception traces, prompts, SQL, raw Elasticsearch documents, API keys, or provider payloads on the stream. `done` means the server completed the request; a socket close without `done` is incomplete. No automatic replay/resume in v1, so the browser must not retry a partially completed POST without a deliberate user action.

`results.events` is a typed list of cards. It is sent once in phase 1; the text can arrive in many `delta` frames. If an LLM narrative is not essential for launch, generate the one-line summary from templates and still stream it in small semantic chunks. This keeps the first release useful during provider outages and avoids paying for prose that merely repeats cards. Use an LLM for natural-language **criteria extraction** when needed; distinguish extraction latency from output streaming in metrics.

### 4.2 Search criteria extraction

Create `src/services/chat/interpretEventSearch.ts` with a strict result type:

```ts
type EventSearchCriteria = {
  text?: string;       // semantic terms, e.g. "jazz"
  location?: string;   // e.g. "Berlin"
  limit: number;
};
```

The interpreter must output only this schema; validate and normalize it after the model call. The model may extract intent and terms, but it may not choose an Elasticsearch index, write Query DSL, invent filters, or grant access to data. Ignore unsupported fields instead of pretending the backend can filter by them. For example, `category` is not in the current event schema or index; do not offer reliable “music/comedy” filtering until that field exists. A simple deterministic path may handle obvious requests; use a bounded structured-output model call for less predictable language. If extraction fails or times out, either fall back to a safe whole-message search with a clear limitation or return a typed failure; do not silently broaden a restrictive request.

Add table-driven examples for location-only, text-plus-location, generic browse, ambiguous city names, quoted names, empty input, and adversarial requests. Treat the user's message as data, not as system instructions.

### 4.3 Typed search service

Refactor `src/services/events/eventsSearchService.ts` to accept validated criteria. Build Query DSL in code:

- If `text` exists, query name and description for relevance. If absent, use an appropriate browse query rather than forcing `multi_match` on the full user sentence.
- Apply `location` as a separate clause; the current `location` is free text, so document whether matching is approximate. A normalized city field is a later schema enhancement if exact city filtering is required.
- Filter cancelled events and `startsAt >= now`; impose a size cap and deterministic tie-break ordering. Do not use model-generated raw DSL.
- Request only IDs and minimal ranking fields from Elasticsearch. Set a short search timeout and define behavior for Elasticsearch unavailable or index missing (typed service error; do not claim no events).
- Overfetch by a small bounded amount so PostgreSQL hydration can discard stale or ineligible hits while still filling up to `limit` cards. Do not loop indefinitely.

Elasticsearch is a candidate finder, not the final source of truth. Query PostgreSQL for the returned IDs in one batch, filter `deletedAt IS NULL`, `isCancelled = false`, `startsAt >= now`, and apply public visibility rules. Preserve Elasticsearch rank when returning cards. If the desired number of cards cannot be filled because index data is stale, return fewer cards rather than stale results. Use typed DTO projection; never return `userId`, internal timestamps, raw descriptions beyond an agreed preview length, or search internals to the frontend.

The outbox currently indexes `event.created` only. Document and prioritize `event.updated`, `event.cancelled`, and `event.deleted` index maintenance before relying on search freshness at scale. In phase 1, PostgreSQL hydration protects against stale removals, but **new/edited events may still be missing from search** until indexing catches up. Add an index rebuild/backfill procedure and tests for replay/idempotency before production launch.

### 4.4 Small LangGraph workflow

Implement the graph under `src/chat/` and compile it once at process startup. Suggested nodes:

```text
START → interpretSearch → searchCandidates → hydrateCards → composeSummary → END
```

State should contain the original message, validated criteria, candidate IDs, public cards, and a bounded response status. Store raw typed values in state; build provider prompts inside the relevant node. Nodes call existing services and return state updates. Keep node names stable for traces. Use graph streaming only for events needed by the client; do not expose full state or provider metadata. LangGraph currently offers typed event streaming for new applications and stream modes such as `messages` and `custom`; select a pinned API/version and adapt graph events to the public SSE contract. If summary text is templated in phase 1, emit application `custom` data for it; if using a model for prose, filter stream output to the `composeSummary` node so internal extraction output never leaks.

No checkpointer is required for a truly single-turn phase 1 graph. Do not use an in-memory checkpointer as if it were durable conversation history. Add durable persistence only when a conversation feature is implemented, with server-verified user ownership and a per-conversation identifier.

### 4.5 Stream handler and cancellation

Add a `chatRoutes` router under global `requireAuth` in `src/server.ts`. A controller validates input, generates a request ID, starts an `AbortController`, and connects response close to graph/provider cancellation. In Node/Express, distinguish a normal completed response from premature disconnect; clean up listeners, timers, and active-stream counters in `finally`.

For each frame, serialize one JSON object and escape it through JSON serialization. Respect writable backpressure (`res.write()` returning `false` and waiting for `drain`); stop work if the socket is gone. Bound extraction, search, hydration, and generation time separately, plus one total deadline. Do not start another LLM call to recover a connection that has closed. Errors before stream start use JSON status; errors after stream start use `error` SSE and `res.end()` when possible. Update the global error handler in `src/server.ts` so it does not write JSON after `res.headersSent`.

### 4.6 Frontend behavior

Use `fetch()` with `Authorization` and `Accept: text/event-stream`, `AbortController`, `TextDecoder` in streaming mode, and an SSE parser that handles frames split across arbitrary network chunks. Do not assume each `reader.read()` contains one complete event. Render a pending state on `status`, replace event cards on `results`, append text on `delta`, and mark completion only on `done`. If the stream closes without `done`, show an incomplete-response state. Cancel the request when the user leaves the view or presses Stop.

Render cards from structured data with normal application components. Escape text and sanitize any rendered Markdown. Use server supplied event IDs to build app routes according to the frontend router; never use links invented by the model. Show price with `ticketPriceCents` and `currencyCode`, and avoid displaying a “tickets available” claim until a live availability capability exists.

### 4.7 Configuration and dependencies

- Add pinned compatible versions of `@langchain/langgraph`, its required core package(s), and the selected model integration or provider SDK. Verify their actual APIs against the versions installed; do not copy examples from a different major version.
- Add model provider secret, model ID, request deadlines, max results, and optional chat feature flag to `src/config/env.ts` and `.env.example`. Never log secrets or send them to the client.
- Keep search and database clients already used by the API. No new datastore is required in phase 1.
- A per-user rate limiter should count requests, while a separate active-stream cap limits simultaneous expensive work. If deployment uses multiple API instances, move shared limits to a shared store; process-memory limits only govern one instance.

## 5. Phase 2 — reliable search and guided choices

1. Add explicit `category`/tags and normalized city fields to PostgreSQL with a migration; update create/edit validation, index mappings, outbox payloads, and backfill. Define a controlled category vocabulary. Do not derive category solely from arbitrary descriptions.
2. Implement index updates/deletes for event lifecycle changes and a repair/reindex command. Track outbox lag and index divergence.
3. Extend criteria with `category`, date range, price range, and other filters only after each has a trustworthy source field and validation rules.
4. Add a decision node for a genuine follow-up: when a broad search has many useful categories, return `choice` objects such as `{id, label, action:{type:"select_category",category:"music"}}`. The frontend sends the structured action back. The backend validates allowed values and repeats the search. The model may phrase the question but cannot invent action IDs or categories.
5. Define pagination or “show more” with a server-issued cursor or validated criteria; do not have the model fabricate offsets. For deep pagination, use the Elasticsearch mechanism appropriate to the chosen sort and consistency requirements.

**Exit gate:** “events in Berlin” followed by a click on “Music” produces filtered results without relying on the model to reinterpret the click.

## 6. Phase 3 — conversations and FAQs

1. Add `conversations` and `messages` tables in PostgreSQL, owned by `userId`, with indexes, retention/deletion policy, and a stable `conversationId`. Define whether history is visible across devices.
2. Introduce a durable LangGraph checkpointer only if graph state must resume across requests. Scope its thread ID to a server-authorized conversation; never trust a client-provided thread ID without ownership checks. Keep only necessary state and bound history size. Avoid storing full event snapshots as long-term truth; re-read fresh data when answering.
3. Add curated FAQ documents with version, visibility, and source identifiers. Use keyword search first if the corpus is small; add embeddings/vector retrieval only when relevance tests show a need. Send source IDs with answers and refuse unsupported claims.
4. Add routing nodes: event discovery, event detail, FAQ retrieval, and clarification. Require tool results for facts. Record which source supported each answer.

**Exit gate:** a user can ask a follow-up, return later, and receive an answer grounded in the right conversation and current public facts.

## 7. Phase 4 — availability and actions

1. Add a read-only availability service backed by PostgreSQL, with a clear timestamp and semantics for reservations. Query it near answer time; do not use the Elasticsearch event snapshot or old graph state for live inventory.
2. Route availability questions to this service and label quantities as point-in-time. Checkout remains authoritative and must recheck inventory transactionally.
3. Keep booking/payment actions outside the chat until explicit product requirements exist. If actions are added, use server-side authorization, typed commands, idempotency keys, and confirmation before mutations. Do not let a model directly execute arbitrary SQL or purchase tickets.

## 8. Cross-cutting quality gates

### Security and privacy

- Authenticate before expensive work; enforce user ownership for future conversations.
- Treat user messages, event descriptions, and FAQ text as untrusted data. Separate them from application instructions; restrict the graph to approved read-only tools in the early phases.
- Allowlist context fields and cap text/token sizes. Do not include organizer identifiers, secrets, payment data, or other users' conversations.
- Do not log full prompts or chat text by default. Redact request logs and use a retention policy for any opt-in trace content.
- Bound input length, result count, output tokens, request duration, and active streams. Use provider budget/usage monitoring.
- Render assistant text safely and treat structured card fields as ordinary untrusted strings in the UI.

### Observability and operations

- Correlate HTTP request ID, graph run, Elasticsearch query, DB hydration, and provider request where supported. Log event IDs and timings rather than raw message text.
- Metrics: request count by finish reason, validation/rate-limit failures, active streams, client aborts, time to results, time to first text, total latency, extraction failures, Elasticsearch failures, hydration discard count, provider token usage/cost, and outbox lag.
- Set alerts for elevated error rate, streaming stalls, search/index failures, and spend spikes. Document operational behavior for provider or Elasticsearch outage.
- Verify deployment proxy/load-balancer idle timeout, response buffering, compression, HTTP/2 behavior, and graceful shutdown of active streams.

### Tests and acceptance scenarios

- Unit: Zod schemas, criteria normalization, query builder, public-card projection, SSE serialization/parser, and `done`/`error` state handling.
- Integration with disposable PostgreSQL/Elasticsearch and a fake LLM: location-only query, text-plus-location query, no results, stale cancelled/deleted hit, order preservation, index missing, search timeout, provider timeout, and disconnect cancellation.
- HTTP: missing/expired JWT, malformed JSON, oversized input, rate limit, CORS preflight, correct SSE headers, multiple frames in one network chunk, one frame split across chunks, and close without `done`.
- Model evaluation set: representative event searches and hostile prompts. Assert criteria accuracy and that returned cards always originate from verified database rows. Track regressions when model or prompt versions change.
- Load: sustained concurrent streams, memory/backpressure, database pool saturation (`pg` pool currently max 5), proxy behavior, and token-cost ceilings.

**Phase 1 release acceptance:** searches such as “events in Berlin” return only current public upcoming PostgreSQL-backed cards; the browser shows cards before or while text arrives; stop/navigation aborts backend work; no-match, errors, and incomplete streams have distinct UI states; metrics expose latency and failures.

## 9. Suggested implementation order and file map

1. `docs/event-chat-implementation-plan.md`: agree on scope, visibility, timezone, and contract.
2. `src/config/env.ts`, `.env.example`: provider and chat limits.
3. `src/services/chat/eventSearchCriteria.ts`: strict criteria schema and normalization; the `interpretSearch` LangGraph node performs model extraction.
4. `src/services/events/eventsSearchService.ts`: criteria-based Elasticsearch query.
5. `src/services/events/eventsService.ts` or a dedicated read service: batch public-card hydration from PostgreSQL.
6. `src/chat/eventDiscoveryGraph.ts`: small compiled graph.
7. `src/controllers/chat/chatController.ts`, `src/routes/chatRoutes.ts`, `src/server.ts`: authenticated SSE endpoint, cancellation, error handling.
8. Test runner and focused tests; local transport test through the frontend/proxy path.
9. Frontend repository: stream parser, UI states, structured cards, abort behavior.
10. Outbox/index lifecycle work and backfill before production reliance on search freshness.

## 10. Sources consulted

- [LangGraph JavaScript streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming) — graph streaming modes and current event-streaming guidance.
- [LangGraph JavaScript persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) — checkpoints and conversation state.
- [Gemini API: streaming](https://ai.google.dev/gemini-api/docs/text-generation#streaming) — provider streaming example.
- [Elasticsearch Query DSL](https://www.elastic.co/docs/explore-analyze/query-filter/languages/querydsl) and [Search API](https://www.elastic.co/guide/en/elasticsearch/reference/current/search-search.html) — query/filter and search behavior.
- [MDN: using readable streams](https://developer.mozilla.org/en-US/docs/Web/API/Streams_API/Using_readable_streams) — browser incremental reading and cancellation.
- [Express error handling](https://expressjs.com/en/guide/error-handling/) — behavior after response headers have been sent.
- [OWASP LLM prompt injection prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) — boundaries for user and retrieved text.
