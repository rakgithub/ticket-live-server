import { and, asc, eq, lte, sql } from "drizzle-orm";
import { env } from "../../config/env.ts";
import { db } from "../../db/client.ts";
import { eventsTable } from "../../db/schema/events.ts";
import {
  inventoryHoldsTable,
  type InventoryHold,
} from "../../db/schema/inventoryHolds.ts";

type InventoryTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

let capacityConflictsTotal = 0;
let expiredHoldsTotal = 0;

export function getInventoryHoldCounters() {
  return { capacityConflictsTotal, expiredHoldsTotal };
}

const holdSelection = {
  holdId: inventoryHoldsTable.holdId,
  orderId: inventoryHoldsTable.orderId,
  eventId: inventoryHoldsTable.eventId,
  eventNameSnapshot: inventoryHoldsTable.eventNameSnapshot,
  eventLocationSnapshot: inventoryHoldsTable.eventLocationSnapshot,
  quantity: inventoryHoldsTable.quantity,
  unitPriceCents: inventoryHoldsTable.unitPriceCents,
  currencyCode: inventoryHoldsTable.currencyCode,
  eventStartsAtSnapshot: inventoryHoldsTable.eventStartsAtSnapshot,
  state: inventoryHoldsTable.state,
  expiresAt: inventoryHoldsTable.expiresAt,
  createdAt: inventoryHoldsTable.createdAt,
  updatedAt: inventoryHoldsTable.updatedAt,
};

export class InventoryHoldError extends Error {
  readonly status: 404 | 409;

  constructor(message: string, status: 404 | 409) {
    super(message);
    this.status = status;
  }
}

type CreateHoldInput = {
  eventId: string;
  orderId: string;
  quantity: number;
};

type CreateHoldOutcome =
  | { hold: InventoryHold; created: boolean }
  | { error: "unavailable" | "capacity" | "idempotency_conflict" };

function sameRequest(
  hold: { eventId: string; quantity: number },
  input: CreateHoldInput,
): boolean {
  return hold.eventId === input.eventId && hold.quantity === input.quantity;
}

function throwCreateOutcome(outcome: CreateHoldOutcome) {
  if ("error" in outcome) {
    if (outcome.error === "unavailable") {
      throw new InventoryHoldError("Event is not available", 404);
    }
    if (outcome.error === "capacity") {
      capacityConflictsTotal += 1;
      throw new InventoryHoldError("Not enough seats are available", 409);
    }
    throw new InventoryHoldError(
      "This order ID was already used for a different inventory hold",
      409,
    );
  }
  return outcome;
}

/**
 * Create one hold per stable order ID. The event row serializes holds with one
 * another and with the legacy checkout capacity updates that still use the
 * same reserved_quantity counter.
 */
export async function createInventoryHold(input: CreateHoldInput) {
  let outcome: CreateHoldOutcome;
  try {
    outcome = await db.transaction(async (tx) => {
      const [prior] = await tx
        .select(holdSelection)
        .from(inventoryHoldsTable)
        .where(eq(inventoryHoldsTable.orderId, input.orderId));

      if (prior && !sameRequest(prior, input)) {
        return { error: "idempotency_conflict" } as const;
      }

      const eventId = prior?.eventId ?? input.eventId;
      const [event] = await tx
        .select({
          id: eventsTable.id,
          name: eventsTable.name,
          location: eventsTable.location,
          maxPeople: eventsTable.maxPeople,
          reservedQuantity: eventsTable.reservedQuantity,
          ticketPriceCents: eventsTable.ticketPriceCents,
          currencyCode: eventsTable.currencyCode,
          startsAt: eventsTable.startsAt,
          isCancelled: eventsTable.isCancelled,
          deletedAt: eventsTable.deletedAt,
        })
        .from(eventsTable)
        .where(eq(eventsTable.id, eventId))
        .for("update");

      if (!event) return { error: "unavailable" } as const;

      const expiredQuantity = await expireActiveHoldsForEvent(tx, event.id, new Date());
      if (prior) {
        const [current] = await tx
          .select(holdSelection)
          .from(inventoryHoldsTable)
          .where(eq(inventoryHoldsTable.orderId, input.orderId));
        if (!current) throw new Error("Inventory hold disappeared during idempotent retry");
        return { hold: current, created: false } as const;
      }

      // A duplicate request can arrive while the first insert is committing.
      // Re-read after obtaining the event lock before allocating capacity.
      const [concurrentPrior] = await tx
        .select(holdSelection)
        .from(inventoryHoldsTable)
        .where(eq(inventoryHoldsTable.orderId, input.orderId));
      if (concurrentPrior) {
        if (!sameRequest(concurrentPrior, input)) {
          return { error: "idempotency_conflict" } as const;
        }
        return { hold: concurrentPrior, created: false } as const;
      }

      if (event.deletedAt || event.isCancelled) {
        return { error: "unavailable" } as const;
      }

      const occupiedQuantity = event.reservedQuantity - expiredQuantity;
      if (occupiedQuantity + input.quantity > event.maxPeople) {
        return { error: "capacity" } as const;
      }

      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + env.PAYMENT_RESERVATION_TTL_SECONDS * 1_000,
      );

      await tx
        .update(eventsTable)
        .set({ reservedQuantity: occupiedQuantity + input.quantity, updatedAt: now })
        .where(eq(eventsTable.id, event.id));

      const [hold] = await tx
        .insert(inventoryHoldsTable)
        .values({
          // The one-hold-per-order invariant makes orderId a stable hold ID too.
          holdId: input.orderId,
          orderId: input.orderId,
          eventId: event.id,
          eventNameSnapshot: event.name,
          eventLocationSnapshot: event.location,
          quantity: input.quantity,
          unitPriceCents: event.ticketPriceCents,
          currencyCode: event.currencyCode,
          eventStartsAtSnapshot: event.startsAt,
          state: "active",
          expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning(holdSelection);

      return { hold, created: true } as const;
    });
  } catch (error) {
    // A retry with the same order ID can race across two event rows. PostgreSQL
    // rolls back the losing transaction, including its capacity increment.
    if (
      typeof error === "object" && error !== null && "code" in error &&
      error.code === "23505"
    ) {
      let existing: InventoryHold | undefined;
      try {
        [existing] = await db
          .select(holdSelection)
          .from(inventoryHoldsTable)
          .where(eq(inventoryHoldsTable.orderId, input.orderId));
      } catch {
        // Preserve the original database error if this lookup also fails.
      }
      if (existing && sameRequest(existing, input)) {
        return { hold: existing, created: false };
      }
      if (existing) {
        throw new InventoryHoldError(
          "This order ID was already used for a different inventory hold",
          409,
        );
      }
    }
    throw error;
  }

  return throwCreateOutcome(outcome);
}

export async function confirmInventoryHold(holdId: string) {
  return transitionHold(holdId, "confirm");
}

export async function releaseInventoryHold(holdId: string) {
  return transitionHold(holdId, "release");
}

async function transitionHold(holdId: string, action: "confirm" | "release") {
  const result = await db.transaction(async (tx) => {
    const [initial] = await tx
      .select({ eventId: inventoryHoldsTable.eventId })
      .from(inventoryHoldsTable)
      .where(eq(inventoryHoldsTable.holdId, holdId));

    if (!initial) return { error: "missing" } as const;

    const [event] = await tx
      .select({ id: eventsTable.id })
      .from(eventsTable)
      .where(eq(eventsTable.id, initial.eventId))
      .for("update");

    if (!event) return { error: "missing" } as const;
    await expireActiveHoldsForEvent(tx, event.id, new Date());

    const [hold] = await tx
      .select(holdSelection)
      .from(inventoryHoldsTable)
      .where(eq(inventoryHoldsTable.holdId, holdId))
      .for("update");

    if (!hold) return { error: "missing" } as const;
    if (action === "confirm") {
      if (hold.state === "confirmed") return { hold } as const;
      if (hold.state !== "active") return { error: "invalid_transition" } as const;

      const [confirmed] = await tx
        .update(inventoryHoldsTable)
        .set({ state: "confirmed", updatedAt: new Date() })
        .where(
          and(
            eq(inventoryHoldsTable.holdId, holdId),
            eq(inventoryHoldsTable.state, "active"),
          ),
        )
        .returning(holdSelection);

      return confirmed
        ? { hold: confirmed } as const
        : { error: "invalid_transition" } as const;
    }

    if (hold.state === "released" || hold.state === "expired") {
      return { hold } as const;
    }
    if (hold.state === "confirmed") return { error: "invalid_transition" } as const;

    const [released] = await tx
      .update(inventoryHoldsTable)
      .set({ state: "released", updatedAt: new Date() })
      .where(
        and(
          eq(inventoryHoldsTable.holdId, holdId),
          eq(inventoryHoldsTable.state, "active"),
        ),
      )
      .returning(holdSelection);

    if (!released) return { error: "invalid_transition" } as const;

    await tx
      .update(eventsTable)
      .set({
        reservedQuantity: sql`${eventsTable.reservedQuantity} - ${hold.quantity}`,
        updatedAt: new Date(),
      })
      .where(eq(eventsTable.id, event.id));

    return { hold: released } as const;
  });

  if ("error" in result) {
    if (result.error === "missing") {
      throw new InventoryHoldError("Inventory hold not found", 404);
    }
    throw new InventoryHoldError(
      action === "confirm"
        ? "Inventory hold cannot be confirmed in its current state"
        : "A confirmed inventory hold cannot be released",
      409,
    );
  }
  return result.hold;
}

export async function getInventoryHold(holdId: string) {
  const result = await db.transaction(async (tx) => {
    const [initial] = await tx
      .select({ eventId: inventoryHoldsTable.eventId })
      .from(inventoryHoldsTable)
      .where(eq(inventoryHoldsTable.holdId, holdId));

    if (!initial) return undefined;

    const [event] = await tx
      .select({ id: eventsTable.id })
      .from(eventsTable)
      .where(eq(eventsTable.id, initial.eventId))
      .for("update");
    if (!event) return undefined;

    await expireActiveHoldsForEvent(tx, event.id, new Date());
    const [hold] = await tx
      .select(holdSelection)
      .from(inventoryHoldsTable)
      .where(eq(inventoryHoldsTable.holdId, holdId));
    return hold;
  });

  if (!result) throw new InventoryHoldError("Inventory hold not found", 404);
  return result;
}

/** Expire holds across events in small, ordered batches. Safe across API replicas. */
export async function expireExpiredInventoryHolds(): Promise<number> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const candidates = await tx
      .select({ eventId: inventoryHoldsTable.eventId })
      .from(inventoryHoldsTable)
      .where(
        and(
          eq(inventoryHoldsTable.state, "active"),
          lte(inventoryHoldsTable.expiresAt, now),
        ),
      )
      .groupBy(inventoryHoldsTable.eventId)
      .orderBy(asc(inventoryHoldsTable.eventId))
      .limit(100);

    let releasedQuantity = 0;
    for (const { eventId } of candidates) {
      const [event] = await tx
        .select({ id: eventsTable.id })
        .from(eventsTable)
        .where(eq(eventsTable.id, eventId))
        .for("update");
      if (!event) continue;
      releasedQuantity += await expireActiveHoldsForEvent(tx, event.id, now);
    }
    return releasedQuantity;
  });
}

async function expireActiveHoldsForEvent(
  tx: InventoryTransaction,
  eventId: string,
  now: Date,
): Promise<number> {
  const expired = await tx
    .update(inventoryHoldsTable)
    .set({ state: "expired", updatedAt: now })
    .where(
      and(
        eq(inventoryHoldsTable.eventId, eventId),
        eq(inventoryHoldsTable.state, "active"),
        lte(inventoryHoldsTable.expiresAt, now),
      ),
    )
    .returning({ quantity: inventoryHoldsTable.quantity });

  const expiredQuantity = expired.reduce((total, hold) => total + hold.quantity, 0);
  expiredHoldsTotal += expired.length;
  if (expiredQuantity > 0) {
    await tx
      .update(eventsTable)
      .set({
        reservedQuantity: sql`${eventsTable.reservedQuantity} - ${expiredQuantity}`,
        updatedAt: now,
      })
      .where(eq(eventsTable.id, eventId));
  }
  return expiredQuantity;
}
