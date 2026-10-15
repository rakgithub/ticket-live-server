import {
  CheckoutResponseSchema,
  type CheckoutResponse,
  type InventoryHold,
} from "@ticket-live/contracts";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { db } from "../../db/client.ts";
import { checkoutAttemptsTable } from "../../db/schema/checkoutAttempts.ts";
import { orderOutboxEventsTable } from "../../db/schema/orderOutboxEvents.ts";
import { ordersTable } from "../../db/schema/orders.ts";
import { paymentsTable } from "../../db/schema/payments.ts";
import { usersTable } from "../../db/schema/users.ts";
import { createLogger } from "../../observability/logger.ts";
import { withTraceMetadata } from "../../observability/traceContext.ts";
import {
  getInventoryClient,
  InventoryServiceError,
} from "../events/inventoryClient.ts";
import { mockPaymentProvider } from "../payments/mockPaymentProvider.ts";
import { releaseInventoryHoldCommand } from "./releaseInventoryHold.ts";

const reconciliationBatchSize = 25;
const reconciliationStaleMs = 60_000;
const logger = createLogger("ticket-live-checkout-reconciler");

export type CheckoutInput = {
  eventId: string;
  quantity: number;
};

export class CheckoutError extends Error {
  readonly status: 400 | 404 | 409 | 500 | 503;

  constructor(message: string, status: 400 | 404 | 409 | 500 | 503) {
    super(message);
    this.status = status;
  }
}

type CheckoutAttempt = {
  id: string;
  requestHash: string;
  orderId: string;
  state: "in_progress" | "succeeded" | "failed";
  responseStatus: number | null;
  responseBody: Record<string, unknown> | null;
  created: boolean;
};

export async function checkout(
  userId: string,
  input: CheckoutInput,
  idempotencyKey: string,
): Promise<CheckoutResponse> {
  // Fail before reserving an idempotency key if the internal Event interface
  // cannot be called in this deployment.
  const inventory = getInventoryClient();
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ eventId: input.eventId, quantity: input.quantity }))
    .digest("hex");
  const attempt = await beginCheckoutAttempt(userId, idempotencyKey, requestHash);

  if (!attempt.created) {
    if (attempt.requestHash !== requestHash) {
      throw new CheckoutError(
        "This Idempotency-Key was already used with different checkout details",
        409,
      );
    }
    if (attempt.state === "succeeded") {
      if (!attempt.responseBody) {
        throw new Error("Successful checkout attempt has no saved response");
      }
      return CheckoutResponseSchema.parse(attempt.responseBody);
    }
    if (attempt.state === "failed") {
      throw savedCheckoutError(attempt);
    }
    throw new CheckoutError(
      "A checkout using this Idempotency-Key is still being processed; retry with the same key",
      409,
    );
  }

  try {
    const [customer] = await db
      .select({ name: usersTable.displayName, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    if (!customer) {
      throw new CheckoutError("Customer account is not available", 404);
    }

    const hold = await createOrRecoverHold(inventory, attempt.orderId, input);
    if (hold.state !== "active") {
      if (hold.state === "confirmed") {
        throw new CheckoutError(
          "This checkout is being reconciled; retry with the same key",
          503,
        );
      }
      throw new CheckoutError("The inventory hold is no longer active", 409);
    }

    const reservation = await persistPendingOrderAndPayment(
      attempt,
      userId,
      customer,
      hold,
    );
    const paymentResult = await mockPaymentProvider.charge({
      paymentId: reservation.payment.id,
      amountCents: reservation.order.totalAmountCents,
      currencyCode: reservation.order.currencyCode,
    });

    if (paymentResult.status === "failed") {
      const releaseEventId = await failPaymentAndQueueRelease(
        attempt.id,
        attempt.orderId,
        reservation.payment.id,
      );
      if (releaseEventId) await deliverReleasePromptly(releaseEventId, attempt.orderId);
      throw new CheckoutError("Payment was declined", 409);
    }

    const paymentState = await recordPaymentSuccess(
      attempt.id,
      attempt.orderId,
      reservation.payment.id,
    );
    if (paymentState === "reconciliation_required") {
      throw new CheckoutError(
        "Payment completed after the reservation expired and requires reconciliation",
        409,
      );
    }

    const holdState = await ensureHoldConfirmed(inventory, attempt.orderId);
    if (holdState !== "confirmed") {
      if (holdState === "unknown") {
        throw new CheckoutError(
          "Checkout confirmation is pending reconciliation; retry with the same key",
          503,
        );
      }
      await markReconciliationRequired(
        attempt.id,
        attempt.orderId,
        "Payment succeeded but the inventory hold expired before confirmation",
      );
      throw new CheckoutError(
        "Payment succeeded but the reservation expired; the order requires reconciliation",
        409,
      );
    }

    const finalized = await finalizeConfirmedOrder(attempt.id, attempt.orderId);
    if (finalized.kind === "reconciliation_required") {
      throw new CheckoutError(
        "Payment succeeded but the order requires reconciliation",
        409,
      );
    }
    return finalized.response;
  } catch (error) {
    if (error instanceof CheckoutError) {
      if (error.status === 400 || error.status === 404 || error.status === 409) {
        await saveFailedAttempt(attempt.id, attempt.orderId, error);
      }
      throw error;
    }

    // Keep an uncertain attempt open so a worker can inspect the hold and local
    // Order state. A retry must never assume that a timed-out Event call failed.
    throw new CheckoutError(
      "Checkout is being reconciled; retry with the same Idempotency-Key",
      503,
    );
  }
}

async function deliverReleasePromptly(eventId: string, holdId: string): Promise<void> {
  try {
    await releaseInventoryHoldCommand(holdId);
    await db
      .update(orderOutboxEventsTable)
      .set({ processedAt: new Date(), lastError: null })
      .where(and(eq(orderOutboxEventsTable.id, eventId), isNull(orderOutboxEventsTable.processedAt)));
  } catch {
    // The durable outbox row remains pending for the worker to retry.
  }
}

async function beginCheckoutAttempt(
  userId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<CheckoutAttempt> {
  const newOrderId = randomUUID();
  const [created] = await db
    .insert(checkoutAttemptsTable)
    .values({ userId, idempotencyKey, requestHash, orderId: newOrderId })
    .onConflictDoNothing({
      target: [checkoutAttemptsTable.userId, checkoutAttemptsTable.idempotencyKey],
    })
    .returning({ id: checkoutAttemptsTable.id });

  if (created) {
    return {
      id: created.id,
      requestHash,
      orderId: newOrderId,
      state: "in_progress",
      responseStatus: null,
      responseBody: null,
      created: true,
    };
  }

  let [existing] = await db
    .select({
      id: checkoutAttemptsTable.id,
      requestHash: checkoutAttemptsTable.requestHash,
      orderId: checkoutAttemptsTable.orderId,
      state: checkoutAttemptsTable.state,
      responseStatus: checkoutAttemptsTable.responseStatus,
      responseBody: checkoutAttemptsTable.responseBody,
    })
    .from(checkoutAttemptsTable)
    .where(
      and(
        eq(checkoutAttemptsTable.userId, userId),
        eq(checkoutAttemptsTable.idempotencyKey, idempotencyKey),
      ),
    );

  if (!existing) throw new Error("Checkout idempotency record could not be loaded");
  if (
    existing.state !== "in_progress" && existing.state !== "succeeded" &&
    existing.state !== "failed"
  ) {
    throw new Error("Checkout attempt has an invalid state");
  }
  if (!existing.orderId && existing.state === "in_progress") {
    const [assigned] = await db
      .update(checkoutAttemptsTable)
      .set({ orderId: newOrderId, updatedAt: new Date() })
      .where(
        and(
          eq(checkoutAttemptsTable.id, existing.id),
          isNull(checkoutAttemptsTable.orderId),
          eq(checkoutAttemptsTable.state, "in_progress"),
        ),
      )
      .returning({ orderId: checkoutAttemptsTable.orderId });
    existing = { ...existing, orderId: assigned?.orderId ?? existing.orderId };
    if (!existing.orderId) {
      const [refreshed] = await db
        .select({ orderId: checkoutAttemptsTable.orderId })
        .from(checkoutAttemptsTable)
        .where(eq(checkoutAttemptsTable.id, existing.id));
      existing = { ...existing, orderId: refreshed?.orderId ?? null };
    }
  }
  if (!existing.orderId && existing.state !== "in_progress") {
    // Pre-state-machine terminal attempts could have failed before storing an
    // order ID. Their saved response is still authoritative for idempotency.
    return {
      ...existing,
      orderId: newOrderId,
      state: existing.state as CheckoutAttempt["state"],
      created: false,
    };
  }
  if (!existing.orderId) throw new Error("Checkout attempt has no stable order ID");
  return {
    ...existing,
    orderId: existing.orderId,
    state: existing.state as CheckoutAttempt["state"],
    created: false,
  };
}

function savedCheckoutError(attempt: CheckoutAttempt): CheckoutError {
  const responseBody = attempt.responseBody;
  const message = responseBody && typeof responseBody.error === "string"
    ? responseBody.error
    : "Checkout did not complete";
  const status = attempt.responseStatus;
  if (status !== 400 && status !== 404 && status !== 409 && status !== 500) {
    throw new Error("Failed checkout attempt has an invalid saved status");
  }
  return new CheckoutError(message, status);
}

async function createOrRecoverHold(
  inventory: ReturnType<typeof getInventoryClient>,
  orderId: string,
  input: CheckoutInput,
): Promise<InventoryHold> {
  try {
    const created = (await inventory.createHold(input.eventId, {
      orderId,
      quantity: input.quantity,
    })).hold;
    assertHoldMatchesRequest(created, orderId, input);
    return created;
  } catch (error) {
    if (
      error instanceof InventoryServiceError &&
      (error.status === 400 || error.status === 404 || error.status === 409)
    ) {
      throw checkoutErrorFromInventory(error);
    }

    const existing = await getHoldOrUnknown(inventory, orderId);
    if (existing.kind === "found") {
      assertHoldMatchesRequest(existing.hold, orderId, input);
      return existing.hold;
    }
    if (existing.kind === "unknown") {
      throw new CheckoutError("Inventory service response is uncertain", 503);
    }

    // A read-after-timeout can return 404 if the original create has not yet
    // committed. Repeating the same order ID is safe because Event is idempotent.
    try {
      const created = (await inventory.createHold(input.eventId, {
        orderId,
        quantity: input.quantity,
      })).hold;
      assertHoldMatchesRequest(created, orderId, input);
      return created;
    } catch (retryError) {
      if (
        retryError instanceof InventoryServiceError &&
        (retryError.status === 400 || retryError.status === 404 || retryError.status === 409)
      ) {
        throw checkoutErrorFromInventory(retryError);
      }
      throw new CheckoutError("Inventory service response is uncertain", 503);
    }
  }
}

function checkoutErrorFromInventory(error: InventoryServiceError): CheckoutError {
  if (error.status === 400) return new CheckoutError(error.message, 400);
  if (error.status === 404) return new CheckoutError(error.message, 404);
  return new CheckoutError(error.message, 409);
}

function assertHoldMatchesRequest(
  hold: InventoryHold,
  orderId: string,
  input: CheckoutInput,
): void {
  if (
    hold.holdId !== orderId || hold.orderId !== orderId || hold.eventId !== input.eventId ||
    hold.quantity !== input.quantity
  ) {
    throw new CheckoutError("Inventory returned a hold for different checkout details", 409);
  }
}

async function persistPendingOrderAndPayment(
  attempt: CheckoutAttempt,
  userId: string,
  customer: { name: string; email: string },
  hold: InventoryHold,
) {
  const totalAmountCents = hold.unitPriceCents * hold.quantity;
  if (!Number.isSafeInteger(totalAmountCents)) {
    throw new CheckoutError("Checkout amount is invalid", 409);
  }
  const expiresAt = new Date(hold.expiresAt);

  return db.transaction(async (tx) => {
    const now = new Date();
    const [order] = await tx
      .insert(ordersTable)
      .values({
        id: attempt.orderId,
        eventId: hold.eventId,
        userId,
        quantity: hold.quantity,
        status: "initiated",
        eventNameSnapshot: hold.eventNameSnapshot,
        eventLocationSnapshot: hold.eventLocationSnapshot,
        eventStartsAtSnapshot: new Date(hold.eventStartsAtSnapshot),
        customerNameSnapshot: customer.name,
        customerEmailSnapshot: customer.email,
        ticketPriceCents: hold.unitPriceCents,
        currencyCode: hold.currencyCode,
        totalAmountCents,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning({
        id: ordersTable.id,
        eventId: ordersTable.eventId,
        quantity: ordersTable.quantity,
        ticketPriceCents: ordersTable.ticketPriceCents,
        currencyCode: ordersTable.currencyCode,
        totalAmountCents: ordersTable.totalAmountCents,
        expiresAt: ordersTable.expiresAt,
        createdAt: ordersTable.createdAt,
      });

    const [heldOrder] = await tx
      .update(ordersTable)
      .set({ status: "held", updatedAt: now })
      .where(and(eq(ordersTable.id, attempt.orderId), eq(ordersTable.status, "initiated")))
      .returning({ id: ordersTable.id });
    if (!heldOrder) throw new Error("Order could not enter held state");

    const [pendingOrder] = await tx
      .update(ordersTable)
      .set({ status: "pending_payment", updatedAt: now })
      .where(and(eq(ordersTable.id, attempt.orderId), eq(ordersTable.status, "held")))
      .returning({ id: ordersTable.id });
    if (!pendingOrder) throw new Error("Order could not enter pending payment state");

    const [payment] = await tx
      .insert(paymentsTable)
      .values({
        orderId: order.id,
        gateway: "mock",
        gatewayPaymentId: randomUUID(),
        amountCents: totalAmountCents,
        currencyCode: hold.currencyCode,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: paymentsTable.id });

    await tx
      .update(checkoutAttemptsTable)
      .set({ updatedAt: now })
      .where(and(eq(checkoutAttemptsTable.id, attempt.id), eq(checkoutAttemptsTable.state, "in_progress")));

    return { order, payment };
  });
}

async function failPaymentAndQueueRelease(
  attemptId: string,
  orderId: string,
  paymentId: string,
): Promise<string | undefined> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [order] = await tx
      .select({ status: ordersTable.status })
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .for("update");

    let releaseEventId: string | undefined;
    if (order?.status === "pending_payment") {
      const [cancelled] = await tx
        .update(ordersTable)
        .set({ status: "cancelled", updatedAt: now })
        .where(and(eq(ordersTable.id, orderId), eq(ordersTable.status, "pending_payment")))
        .returning({ id: ordersTable.id });
      if (cancelled) {
        await tx
          .update(paymentsTable)
          .set({ status: "failed", updatedAt: now })
          .where(and(eq(paymentsTable.id, paymentId), eq(paymentsTable.status, "pending")));
        const [command] = await tx
          .insert(orderOutboxEventsTable)
          .values({
            eventType: "inventory.hold.release",
            aggregateId: orderId,
            payload: { holdId: orderId, reason: "payment_failed" },
          })
          .returning({ id: orderOutboxEventsTable.id });
        releaseEventId = command?.id;
      }
    }

    const failure = new CheckoutError("Payment was declined", 409);
    await setAttemptFailed(tx, attemptId, orderId, failure, now);
    return releaseEventId;
  });
}

async function recordPaymentSuccess(
  attemptId: string,
  orderId: string,
  paymentId: string,
): Promise<"pending_payment" | "confirmed" | "reconciliation_required"> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [order] = await tx
      .select({ status: ordersTable.status })
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .for("update");
    const [payment] = await tx
      .select({ status: paymentsTable.status })
      .from(paymentsTable)
      .where(eq(paymentsTable.id, paymentId))
      .for("update");
    if (!order || !payment) throw new Error("Checkout payment state could not be loaded");

    if (payment.status === "pending" || payment.status === "cancelled") {
      const [updatedPayment] = await tx
        .update(paymentsTable)
        .set({ status: "succeeded", updatedAt: now })
        .where(
          and(
            eq(paymentsTable.id, paymentId),
            eq(paymentsTable.status, payment.status),
          ),
        )
        .returning({ id: paymentsTable.id });
      if (!updatedPayment) throw new Error("Payment success could not be recorded");
    } else if (payment.status !== "succeeded") {
      throw new Error("Payment is already in a terminal failed state");
    }

    if (order.status === "expired" || order.status === "cancelled") {
      await tx
        .update(ordersTable)
        .set({ status: "reconciliation_required", updatedAt: now })
        .where(
          and(
            eq(ordersTable.id, orderId),
            eq(ordersTable.status, order.status),
          ),
        );
      const failure = new CheckoutError(
        "Payment completed after the reservation expired and requires reconciliation",
        409,
      );
      await setAttemptFailed(tx, attemptId, orderId, failure, now);
      return "reconciliation_required";
    }
    if (order.status === "reconciliation_required") return "reconciliation_required";
    if (order.status === "confirmed") return "confirmed";
    if (order.status !== "pending_payment") {
      throw new Error("Order is not ready for payment confirmation");
    }

    await tx
      .update(checkoutAttemptsTable)
      .set({ updatedAt: now })
      .where(and(eq(checkoutAttemptsTable.id, attemptId), eq(checkoutAttemptsTable.state, "in_progress")));
    return "pending_payment";
  });
}

type HoldConfirmationState = "confirmed" | "expired" | "released" | "missing" | "unknown";

async function ensureHoldConfirmed(
  inventory: ReturnType<typeof getInventoryClient>,
  holdId: string,
): Promise<HoldConfirmationState> {
  try {
    const { hold } = await inventory.confirmHold(holdId);
    if (hold.state !== "active") return hold.state;
  } catch {
    // The confirm may have committed while its HTTP response was lost.
  }

  let current = await getHoldOrUnknown(inventory, holdId);
  if (current.kind === "unknown") return "unknown";
  if (current.kind === "missing") return "missing";
  if (current.hold.state !== "active") return current.hold.state;

  try {
    const { hold } = await inventory.confirmHold(holdId);
    if (hold.state !== "active") return hold.state;
  } catch {
    // Resolve the second ambiguous response with a read below.
  }
  current = await getHoldOrUnknown(inventory, holdId);
  if (current.kind === "unknown") return "unknown";
  if (current.kind === "missing") return "missing";
  return current.hold.state === "active" ? "unknown" : current.hold.state;
}

async function getHoldOrUnknown(
  inventory: ReturnType<typeof getInventoryClient>,
  holdId: string,
): Promise<
  | { kind: "found"; hold: InventoryHold }
  | { kind: "missing" }
  | { kind: "unknown" }
> {
  try {
    return { kind: "found", hold: (await inventory.getHold(holdId)).hold };
  } catch (error) {
    if (error instanceof InventoryServiceError && error.status === 404) {
      return { kind: "missing" };
    }
    return { kind: "unknown" };
  }
}

async function finalizeConfirmedOrder(
  attemptId: string,
  orderId: string,
): Promise<
  | { kind: "confirmed"; response: CheckoutResponse }
  | { kind: "reconciliation_required" }
> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [order] = await tx
      .select({
        id: ordersTable.id,
        eventId: ordersTable.eventId,
        quantity: ordersTable.quantity,
        status: ordersTable.status,
        eventNameSnapshot: ordersTable.eventNameSnapshot,
        eventLocationSnapshot: ordersTable.eventLocationSnapshot,
        eventStartsAtSnapshot: ordersTable.eventStartsAtSnapshot,
        customerNameSnapshot: ordersTable.customerNameSnapshot,
        customerEmailSnapshot: ordersTable.customerEmailSnapshot,
        ticketPriceCents: ordersTable.ticketPriceCents,
        currencyCode: ordersTable.currencyCode,
        totalAmountCents: ordersTable.totalAmountCents,
        expiresAt: ordersTable.expiresAt,
        createdAt: ordersTable.createdAt,
      })
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .for("update");
    const [payment] = await tx
      .select({
        id: paymentsTable.id,
        status: paymentsTable.status,
        gateway: paymentsTable.gateway,
      })
      .from(paymentsTable)
      .where(eq(paymentsTable.orderId, orderId))
      .for("update");
    if (!order || !payment) throw new Error("Confirmed checkout state could not be loaded");
    if (payment.status !== "succeeded") {
      throw new Error("An order cannot be confirmed before payment succeeds");
    }

    if (order.status === "expired" || order.status === "cancelled") {
      await tx
        .update(ordersTable)
        .set({ status: "reconciliation_required", updatedAt: now })
        .where(
          and(
            eq(ordersTable.id, orderId),
            eq(ordersTable.status, order.status),
          ),
        );
      await setAttemptFailed(
        tx,
        attemptId,
        orderId,
        new CheckoutError("Payment succeeded but the order requires reconciliation", 409),
        now,
      );
      return { kind: "reconciliation_required" } as const;
    }
    if (order.status === "reconciliation_required") {
      await setAttemptFailed(
        tx,
        attemptId,
        orderId,
        new CheckoutError("Payment succeeded but the order requires reconciliation", 409),
        now,
      );
      return { kind: "reconciliation_required" } as const;
    }
    if (order.status !== "confirmed") {
      const [confirmed] = await tx
        .update(ordersTable)
        .set({ status: "confirmed", expiresAt: null, updatedAt: now })
        .where(and(eq(ordersTable.id, orderId), eq(ordersTable.status, "pending_payment")))
        .returning({ id: ordersTable.id });
      if (!confirmed) throw new Error("Order could not enter confirmed state");

      await tx.insert(orderOutboxEventsTable).values({
        eventType: "order.confirmed",
        aggregateId: order.id,
        payload: withTraceMetadata({
          orderId: order.id,
          customer: {
            name: order.customerNameSnapshot,
            email: order.customerEmailSnapshot,
          },
          event: {
            id: order.eventId,
            name: order.eventNameSnapshot,
            location: order.eventLocationSnapshot,
            startsAt: order.eventStartsAtSnapshot.toISOString(),
          },
          quantity: order.quantity,
          ticketPriceCents: order.ticketPriceCents,
          totalAmountCents: order.totalAmountCents,
          currencyCode: order.currencyCode,
        }),
      });
    }

    const response = CheckoutResponseSchema.parse({
      event: { id: order.eventId, name: order.eventNameSnapshot },
      order: {
        id: order.id,
        eventId: order.eventId,
        quantity: order.quantity,
        status: "confirmed",
        ticketPriceCents: order.ticketPriceCents,
        currencyCode: order.currencyCode.trim(),
        totalAmountCents: order.totalAmountCents,
        expiresAt: null,
        createdAt: order.createdAt.toISOString(),
      },
      payment: {
        id: payment.id,
        status: "succeeded",
        gateway: payment.gateway,
      },
    });
    await tx
      .update(checkoutAttemptsTable)
      .set({
        state: "succeeded",
        responseStatus: 201,
        responseBody: response as unknown as Record<string, unknown>,
        updatedAt: now,
      })
      .where(
        and(
          eq(checkoutAttemptsTable.id, attemptId),
          eq(checkoutAttemptsTable.state, "in_progress"),
        ),
      );
    return { kind: "confirmed", response } as const;
  });
}

async function markReconciliationRequired(
  attemptId: string,
  orderId: string,
  message: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(ordersTable)
      .set({ status: "reconciliation_required", updatedAt: now })
      .where(
        and(
          eq(ordersTable.id, orderId),
          eq(ordersTable.status, "pending_payment"),
        ),
      );
    await setAttemptFailed(tx, attemptId, orderId, new CheckoutError(message, 409), now);
  });
}

async function saveFailedAttempt(
  attemptId: string,
  orderId: string,
  error: CheckoutError,
): Promise<void> {
  await db.transaction(async (tx) => {
    await setAttemptFailed(tx, attemptId, orderId, error, new Date());
  });
}

async function setAttemptFailed(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  attemptId: string,
  orderId: string,
  error: CheckoutError,
  now: Date,
): Promise<void> {
  await tx
    .update(checkoutAttemptsTable)
    .set({
      orderId,
      state: "failed",
      responseStatus: error.status,
      responseBody: { error: error.message },
      updatedAt: now,
    })
    .where(
      and(
        eq(checkoutAttemptsTable.id, attemptId),
        eq(checkoutAttemptsTable.state, "in_progress"),
      ),
    );
}

/** Continue successful payments whose Event confirmation response was lost. */
export async function reconcileCheckoutState(): Promise<number> {
  const staleBefore = new Date(Date.now() - reconciliationStaleMs);
  const attempts = await db
    .select({
      id: checkoutAttemptsTable.id,
      orderId: checkoutAttemptsTable.orderId,
    })
    .from(checkoutAttemptsTable)
    .where(
      and(
        eq(checkoutAttemptsTable.state, "in_progress"),
        lte(checkoutAttemptsTable.updatedAt, staleBefore),
      ),
    )
    .orderBy(asc(checkoutAttemptsTable.updatedAt))
    .limit(reconciliationBatchSize);

  let examined = 0;
  for (const attempt of attempts) {
    examined += 1;
    try {
      if (attempt.orderId) {
        await reconcileOneCheckoutAttempt(attempt.id, attempt.orderId);
      } else {
        await failAttemptWithoutOrderId(attempt.id);
      }
    } catch (error) {
      // Keep the attempt open and retry on a later bounded reconciliation pass.
      await deferAttempt(attempt.id);
      logger.warn("Checkout reconciliation deferred", {
        attemptId: attempt.id,
        orderId: attempt.orderId ?? undefined,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  return examined;
}

async function failAttemptWithoutOrderId(attemptId: string): Promise<void> {
  await db
    .update(checkoutAttemptsTable)
    .set({
      state: "failed",
      responseStatus: 500,
      responseBody: { error: "Checkout could not be completed" },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(checkoutAttemptsTable.id, attemptId),
        eq(checkoutAttemptsTable.state, "in_progress"),
        isNull(checkoutAttemptsTable.orderId),
      ),
    );
}

async function reconcileOneCheckoutAttempt(
  attemptId: string,
  orderId: string,
): Promise<void> {
  const inventory = getInventoryClient();
  const [order] = await db
    .select({ id: ordersTable.id, status: ordersTable.status })
    .from(ordersTable)
    .where(eq(ordersTable.id, orderId));

  if (!order) {
    const hold = await getHoldOrUnknown(inventory, orderId);
    if (hold.kind === "unknown") {
      await deferAttempt(attemptId);
      return;
    }
    const now = new Date();
    if (hold.kind === "found" && hold.hold.state === "active") {
      await db.transaction(async (tx) => {
        const [attempt] = await tx
          .update(checkoutAttemptsTable)
          .set({
            state: "failed",
            responseStatus: 500,
            responseBody: { error: "Checkout could not be completed" },
            updatedAt: now,
          })
          .where(
            and(
              eq(checkoutAttemptsTable.id, attemptId),
              eq(checkoutAttemptsTable.state, "in_progress"),
            ),
          )
          .returning({ id: checkoutAttemptsTable.id });
        if (attempt) {
          await tx.insert(orderOutboxEventsTable).values({
            eventType: "inventory.hold.release",
            aggregateId: orderId,
            payload: { holdId: orderId, reason: "orphaned_checkout" },
          });
        }
      });
      return;
    }

    await saveFailedAttempt(
      attemptId,
      orderId,
      new CheckoutError("Checkout could not be completed", 500),
    );
    return;
  }

  if (order.status === "confirmed") {
    const finalized = await finalizeConfirmedOrder(attemptId, orderId);
    void finalized;
    return;
  }
  if (order.status === "reconciliation_required") {
    await saveFailedAttempt(
      attemptId,
      orderId,
      new CheckoutError("Payment succeeded but the order requires reconciliation", 409),
    );
    return;
  }
  if (order.status === "expired" || order.status === "cancelled") {
    await saveFailedAttempt(
      attemptId,
      orderId,
      new CheckoutError("Checkout reservation is no longer active", 409),
    );
    return;
  }

  const [payment] = await db
    .select({ status: paymentsTable.status })
    .from(paymentsTable)
    .where(eq(paymentsTable.orderId, orderId));
  if (payment?.status === "succeeded") {
    const holdState = await ensureHoldConfirmed(inventory, orderId);
    if (holdState === "confirmed") {
      await finalizeConfirmedOrder(attemptId, orderId);
    } else if (holdState === "expired" || holdState === "released" || holdState === "missing") {
      await markReconciliationRequired(
        attemptId,
        orderId,
        "Payment succeeded but the inventory hold is no longer confirmable",
      );
    } else {
      await deferAttempt(attemptId);
    }
    return;
  }

  // The mock provider has no query API. Leave an unsettled pending payment to
  // the Order expiry state transition instead of charging it a second time.
  await deferAttempt(attemptId);
}

async function deferAttempt(attemptId: string): Promise<void> {
  await db
    .update(checkoutAttemptsTable)
    .set({ updatedAt: new Date() })
    .where(
      and(
        eq(checkoutAttemptsTable.id, attemptId),
        eq(checkoutAttemptsTable.state, "in_progress"),
      ),
    );
}
