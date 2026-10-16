import { eq, sql } from "drizzle-orm";
import type { EmailSendV1 } from "@ticket-live/contracts";
import { db } from "../../../src/db/client.ts";
import { emailDeliveriesTable } from "../../../src/db/schema/emailDeliveries.ts";
import type { ProviderAcceptance } from "./provider.ts";

const terminalStatuses = new Set([
  "accepted_by_provider",
  "delivered",
  "bounced",
  "failed",
  "simulated",
]);

export async function claimDeliveryIntent(
  message: EmailSendV1,
  providerName: string,
  allowFailedReplay: boolean,
): Promise<{ kind: "terminal" | "not_due" | "conflict" | "claimed"; wasSending?: boolean }> {
  return db.transaction(async (tx) => {
    const now = new Date();
    await tx.insert(emailDeliveriesTable).values({
      eventId: message.commandId,
      notificationKey: message.notificationKey,
      orderId: message.data.orderId,
      recipientEmail: message.recipient,
      status: "queued",
      providerName,
      availableAt: now,
    }).onConflictDoNothing({ target: emailDeliveriesTable.notificationKey });

    const [delivery] = await tx.select({
      id: emailDeliveriesTable.id,
      eventId: emailDeliveriesTable.eventId,
      orderId: emailDeliveriesTable.orderId,
      recipientEmail: emailDeliveriesTable.recipientEmail,
      status: emailDeliveriesTable.status,
      attempts: emailDeliveriesTable.attempts,
      availableAt: emailDeliveriesTable.availableAt,
    }).from(emailDeliveriesTable)
      .where(eq(emailDeliveriesTable.notificationKey, message.notificationKey))
      .for("update");
    if (!delivery) throw new Error("Email delivery intent could not be loaded");
    if (
      delivery.eventId !== message.commandId ||
      delivery.orderId !== message.data.orderId ||
      delivery.recipientEmail !== message.recipient
    ) return { kind: "conflict" };
    if (terminalStatuses.has(delivery.status) && !(delivery.status === "failed" && allowFailedReplay)) {
      return { kind: "terminal" };
    }
    if (delivery.status === "queued" && delivery.availableAt > now) return { kind: "not_due" };

    await tx.update(emailDeliveriesTable).set({
      status: "sending",
      providerName,
      attempts: sql`${emailDeliveriesTable.attempts} + 1`,
      lastAttemptAt: now,
      availableAt: now,
      failedAt: null,
      lastError: null,
      updatedAt: now,
    }).where(eq(emailDeliveriesTable.id, delivery.id));

    return { kind: "claimed", wasSending: delivery.status === "sending" };
  });
}

export async function recordProviderAcceptance(
  notificationKey: string,
  acceptance: ProviderAcceptance,
): Promise<void> {
  await db.update(emailDeliveriesTable).set({
    status: "accepted_by_provider",
    providerName: acceptance.providerName,
    providerMessageId: acceptance.providerMessageId,
    providerAcceptedAt: acceptance.acceptedAt,
    lastError: null,
    updatedAt: new Date(),
  }).where(eq(emailDeliveriesTable.notificationKey, notificationKey));
}

export async function scheduleDeliveryRetry(
  notificationKey: string,
  availableAt: Date,
  errorCode: string,
): Promise<void> {
  await db.update(emailDeliveriesTable).set({
    status: "queued",
    availableAt,
    lastError: errorCode,
    updatedAt: new Date(),
  }).where(eq(emailDeliveriesTable.notificationKey, notificationKey));
}

export async function recordDeliveryFailure(
  notificationKey: string,
  providerName: string,
  errorCode: string,
): Promise<void> {
  const now = new Date();
  await db.update(emailDeliveriesTable).set({
    status: "failed",
    providerName,
    failedAt: now,
    lastError: errorCode,
    updatedAt: now,
  }).where(eq(emailDeliveriesTable.notificationKey, notificationKey));
}

export async function recordUnknownProviderOutcome(
  notificationKey: string,
  providerName: string,
  errorCode: string,
): Promise<void> {
  await db.update(emailDeliveriesTable).set({
    status: "sending",
    providerName,
    lastError: errorCode,
    updatedAt: new Date(),
  }).where(eq(emailDeliveriesTable.notificationKey, notificationKey));
}

export async function getDeliveryByNotificationKey(notificationKey: string) {
  const [delivery] = await db.select({
    id: emailDeliveriesTable.id,
    notificationKey: emailDeliveriesTable.notificationKey,
    orderId: emailDeliveriesTable.orderId,
    status: emailDeliveriesTable.status,
    providerName: emailDeliveriesTable.providerName,
    providerMessageId: emailDeliveriesTable.providerMessageId,
    providerAcceptedAt: emailDeliveriesTable.providerAcceptedAt,
    deliveredAt: emailDeliveriesTable.deliveredAt,
    bouncedAt: emailDeliveriesTable.bouncedAt,
    failedAt: emailDeliveriesTable.failedAt,
    attempts: emailDeliveriesTable.attempts,
    createdAt: emailDeliveriesTable.createdAt,
    updatedAt: emailDeliveriesTable.updatedAt,
  }).from(emailDeliveriesTable)
    .where(eq(emailDeliveriesTable.notificationKey, notificationKey));
  return delivery;
}

export async function getEmailDeliveryMetricRows() {
  return db.select({
    status: emailDeliveriesTable.status,
    providerName: emailDeliveriesTable.providerName,
    deliveryCount: sql<number>`count(*)::int`,
    attemptsTotal: sql<number>`coalesce(sum(${emailDeliveriesTable.attempts}), 0)::int`,
    activeRetries: sql<number>`count(*) filter (
      where ${emailDeliveriesTable.attempts} > 0
        and ${emailDeliveriesTable.status} in ('queued', 'sending')
    )::int`,
    unknownProviderOutcomes: sql<number>`count(*) filter (
      where ${emailDeliveriesTable.status} = 'sending'
        and ${emailDeliveriesTable.lastError} = 'unknown_provider_outcome'
    )::int`,
  }).from(emailDeliveriesTable)
    .groupBy(emailDeliveriesTable.status, emailDeliveriesTable.providerName);
}
