import { and, eq } from "drizzle-orm";
import type { InternalPaymentChargeRequest, InternalPaymentRecord } from "@ticket-live/contracts";
import { db } from "../db/client.ts";
import { paymentsTable } from "../db/schema/payments.ts";
import { mockPaymentProvider } from "./mockPaymentProvider.ts";

function toRecord(payment: typeof paymentsTable.$inferSelect): InternalPaymentRecord {
  return {
    id: payment.id,
    orderId: payment.orderId,
    status: payment.status as InternalPaymentRecord["status"],
    gateway: payment.gateway,
  };
}

export async function chargePayment(request: InternalPaymentChargeRequest): Promise<InternalPaymentRecord> {
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(paymentsTable)
        .where(eq(paymentsTable.orderId, request.orderId))
        .for("update");
      if (existing) {
        if (existing.amountCents !== request.amountCents || existing.currencyCode.trim() !== request.currencyCode) {
          throw new Error("Order already has a payment with different amount details");
        }
        return toRecord(existing);
      }

      const [payment] = await tx
        .insert(paymentsTable)
        .values({
          orderId: request.orderId,
          gateway: "mock",
          gatewayPaymentId: request.orderId,
          amountCents: request.amountCents,
          currencyCode: request.currencyCode,
          status: "pending",
        })
        .returning();
      if (!payment) throw new Error("Payment could not be created");

      const result = await mockPaymentProvider.charge();
      const [updated] = await tx
        .update(paymentsTable)
        .set({ status: result.status, updatedAt: new Date() })
        .where(and(eq(paymentsTable.id, payment.id), eq(paymentsTable.status, "pending")))
        .returning();
      return toRecord(updated ?? payment);
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await getPaymentByOrder(request.orderId);
    if (!existing) throw error;
    const [stored] = await db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.orderId, request.orderId));
    if (
      !stored || stored.amountCents !== request.amountCents ||
      stored.currencyCode.trim() !== request.currencyCode
    ) {
      throw new Error("Order already has a payment with different amount details", { cause: error });
    }
    return existing;
  }
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export async function getPaymentByOrder(orderId: string): Promise<InternalPaymentRecord | undefined> {
  const [payment] = await db
    .select()
    .from(paymentsTable)
    .where(eq(paymentsTable.orderId, orderId));
  return payment ? toRecord(payment) : undefined;
}

export async function cancelPayment(orderId: string): Promise<InternalPaymentRecord | undefined> {
  return db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.orderId, orderId))
      .for("update");
    if (!payment) return undefined;
    if (payment.status !== "pending") return toRecord(payment);
    const [cancelled] = await tx
      .update(paymentsTable)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(paymentsTable.id, payment.id), eq(paymentsTable.status, "pending")))
      .returning();
    return toRecord(cancelled ?? payment);
  });
}
