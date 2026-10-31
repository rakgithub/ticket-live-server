import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { Pool } from "pg";

const publicApiUrl = process.env.PUBLIC_API_URL;
const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL;
const timeoutMs = Number(process.env.BOOKING_SMOKE_TIMEOUT_MS ?? 120_000);

if (!publicApiUrl || !migrationDatabaseUrl || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("Public API, database URL, and positive smoke timeout are required");
}

const database = new Pool({ connectionString: migrationDatabaseUrl, max: 1, statement_timeout: 5_000 });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseState(value) {
  if (!value) throw new Error("Smoke state is required for this phase");
  const state = JSON.parse(value);
  assert(
    state && typeof state === "object" &&
      typeof state.accessToken === "string" &&
      typeof state.email === "string" &&
      typeof state.eventId === "string",
    "Smoke state is invalid",
  );
  return state;
}

async function apiRequest(path, { method = "GET", token, body, idempotencyKey } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const response = await globalThis.fetch(new URL(path, publicApiUrl), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`${method} ${path} returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(`${method} ${path} returned HTTP ${response.status}`);
  return payload;
}

async function waitFor(label, check, durationMs = timeoutMs) {
  const deadline = Date.now() + durationMs;
  let pauseMs = 250;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch {
      // The service or its asynchronous dependency may still be starting.
    }
    await delay(pauseMs);
    pauseMs = Math.min(2_000, Math.ceil(pauseMs * 1.5));
  }
  throw new Error(`${label} did not become ready within ${durationMs} ms`);
}

function parseServerSentEvents(text) {
  return text.split(/\r?\n\r?\n/).flatMap((block) => {
    const event = block.match(/^event:\s*(.+)$/m)?.[1];
    const data = block.match(/^data:\s*(.+)$/m)?.[1];
    if (!event || !data) return [];
    try {
      return [{ event, data: JSON.parse(data) }];
    } catch {
      throw new Error("Event chat returned invalid server-sent event data");
    }
  });
}

async function createSmokeState() {
  await waitFor("Public API readiness", async () => {
    const response = await globalThis.fetch(new URL("/health/ready", publicApiUrl));
    return response.ok;
  });

  const email = `ci-${randomUUID()}@example.test`;
  const password = `ci-smoke-${randomUUID()}-passphrase`;
  const registration = await apiRequest("/register", {
    method: "POST",
    body: { name: "CI Booking Guest", email, password },
  });
  assert(typeof registration?.user?.id === "string", "Registration did not return a user");

  const login = await apiRequest("/login", {
    method: "POST",
    body: { email, password },
  });
  assert(typeof login?.accessToken === "string", "Login did not return an access token");

  const eventName = `CI booking ${randomUUID()}`;
  const eventResponse = await apiRequest("/events", {
    method: "POST",
    token: login.accessToken,
    body: {
      name: eventName,
      description: "Synthetic event for container booking verification.",
      location: "Berlin",
      genre: "jazz",
      minPeople: 1,
      maxPeople: 20,
      ticketPriceCents: 3200,
      currencyCode: "EUR",
      servesAlcohol: false,
      startsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    },
  });
  const eventId = eventResponse?.event?.id;
  assert(typeof eventId === "string", "Event creation did not return an event");

  await waitFor("Deterministic event discovery", async () => {
    const response = await globalThis.fetch(new URL("/chat/events/stream", publicApiUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${login.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "Find jazz events in Berlin", limit: 5 }),
    });
    if (!response.ok) return false;
    const events = parseServerSentEvents(await response.text());
    const results = events.find((event) => event.event === "results")?.data;
    const done = events.find((event) => event.event === "done")?.data;
    return done?.finishReason === "completed" &&
      Array.isArray(results?.events) &&
      results.events.some((candidate) => candidate.id === eventId);
  });

  return { accessToken: login.accessToken, email, eventId };
}

async function createBooking(state) {
  const idempotencyKey = randomUUID();
  const response = await apiRequest("/orders/checkout", {
    method: "POST",
    token: state.accessToken,
    idempotencyKey,
    body: { eventId: state.eventId, quantity: 2 },
  });

  const order = response?.order;
  const payment = response?.payment;
  assert(order?.status === "confirmed", "Checkout did not confirm the order");
  assert(payment?.status === "succeeded" && payment?.gateway === "mock", "Mock payment did not succeed");
  assert(order?.totalAmountCents === order.ticketPriceCents * order.quantity, "Order total did not match its items");
  assert(order?.quantity === 2 && order?.eventId === state.eventId, "Checkout returned the wrong order details");

  await waitFor("Pending order outbox after broker outage", async () => {
    const result = await database.query(
      `SELECT attempts, processed_at
       FROM order_service.outbox_events
       WHERE aggregate_id = $1 AND event_type = 'order.confirmed'
       ORDER BY created_at DESC LIMIT 1`,
      [order.id],
    );
    const outbox = result.rows[0];
    return outbox && Number(outbox.attempts) > 0 && outbox.processed_at === null;
  }, Math.min(timeoutMs, 30_000));

  return {
    ...state,
    orderId: order.id,
    paymentId: payment.id,
    quantity: order.quantity,
  };
}

async function readBookingState(orderId) {
  const result = await database.query(
    `SELECT
       orders.status AS order_status,
       orders.payment_status AS order_payment_status,
       orders.total_amount_cents,
       payments.id AS payment_id,
       payments.status AS payment_status,
       payments.gateway,
       holds.state AS inventory_state,
       holds.quantity AS inventory_quantity,
       events.reserved_quantity,
       (SELECT count(*)::int FROM ticketing_service.tickets WHERE order_id = orders.id) AS ticket_count,
       (SELECT count(*)::int FROM ticketing_service.tickets WHERE order_id = orders.id AND status = 'active') AS active_ticket_count,
       (SELECT status FROM email_service.email_deliveries WHERE order_id = orders.id LIMIT 1) AS email_status,
       (SELECT provider_name FROM email_service.email_deliveries WHERE order_id = orders.id LIMIT 1) AS email_provider,
       (SELECT provider_message_id FROM email_service.email_deliveries WHERE order_id = orders.id LIMIT 1) AS email_provider_message_id,
       (SELECT recipient_email FROM email_service.email_deliveries WHERE order_id = orders.id LIMIT 1) AS email_recipient,
       (SELECT processed_at FROM order_service.outbox_events WHERE aggregate_id = orders.id AND event_type = 'order.confirmed' LIMIT 1) AS outbox_processed_at,
       (SELECT attempts FROM order_service.outbox_events WHERE aggregate_id = orders.id AND event_type = 'order.confirmed' LIMIT 1) AS outbox_attempts
     FROM order_service.orders AS orders
     JOIN payment_service.payments AS payments ON payments.order_id = orders.id
     JOIN event_service.inventory_holds AS holds ON holds.order_id = orders.id
     JOIN event_service.events AS events ON events.id = orders.event_id
     WHERE orders.id = $1`,
    [orderId],
  );
  return result.rows[0];
}

async function verifyCompletedBooking(state) {
  const row = await waitFor("Recovered booking confirmations", async () => {
    const orders = await apiRequest("/orders", { token: state.accessToken });
    const order = orders?.orders?.find((candidate) => candidate.id === state.orderId);
    if (order?.status !== "confirmed" || order?.paymentStatus !== "succeeded") return false;

    const tickets = await apiRequest("/tickets", { token: state.accessToken });
    const matchingTickets = tickets?.tickets?.filter((ticket) => ticket.orderId === state.orderId) ?? [];
    if (matchingTickets.length !== state.quantity || matchingTickets.some((ticket) => ticket.status !== "active")) {
      return false;
    }

    const bookingState = await readBookingState(state.orderId);
    if (!bookingState) return false;
    if (
      bookingState.order_status !== "confirmed" ||
      bookingState.order_payment_status !== "succeeded" ||
      bookingState.payment_status !== "succeeded" ||
      bookingState.gateway !== "mock" ||
      bookingState.inventory_state !== "confirmed" ||
      Number(bookingState.inventory_quantity) !== state.quantity ||
      Number(bookingState.reserved_quantity) !== state.quantity ||
      Number(bookingState.ticket_count) !== state.quantity ||
      Number(bookingState.active_ticket_count) !== state.quantity ||
      bookingState.email_status !== "accepted_by_provider" ||
      bookingState.email_provider !== "fake" ||
      !String(bookingState.email_provider_message_id ?? "").startsWith("fake:") ||
      bookingState.email_recipient !== state.email ||
      !bookingState.outbox_processed_at ||
      Number(bookingState.outbox_attempts) < 1
    ) return false;

    return bookingState;
  });

  assert(row.payment_id === state.paymentId, "Payment record did not match the checkout response");
  assert(Number(row.total_amount_cents) === 6400, "Persisted order total was incorrect");
  return row;
}

async function main() {
  const phase = process.argv[2];
  if (phase === "prepare") {
    const state = await createSmokeState();
    process.stdout.write(`CI_SMOKE_STATE:${JSON.stringify(state)}\n`);
    return;
  }

  const state = parseState(process.env.SMOKE_STATE_JSON);
  if (phase === "book") {
    const booking = await createBooking(state);
    process.stdout.write(`CI_SMOKE_STATE:${JSON.stringify(booking)}\n`);
    return;
  }

  if (phase === "verify") {
    assert(typeof state.orderId === "string" && typeof state.paymentId === "string", "Booking state is incomplete");
    await verifyCompletedBooking(state);
    process.stdout.write("Container booking flow passed: RabbitMQ recovery, confirmed inventory and payment, issued tickets, and accepted email confirmation.\n");
    return;
  }

  throw new Error("Expected one of the smoke phases: prepare, book, verify");
}

try {
  await main();
} finally {
  await database.end();
}
