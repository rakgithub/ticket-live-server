import { InventoryServiceError, getInventoryClient } from "../events/inventoryClient.ts";

/** Idempotent handler for release commands emitted by the Order outbox. */
export async function releaseInventoryHoldCommand(holdId: string): Promise<void> {
  const inventory = getInventoryClient();
  let hold;
  try {
    hold = (await inventory.getHold(holdId)).hold;
  } catch (error) {
    if (error instanceof InventoryServiceError && error.status === 404) return;
    throw error;
  }

  if (hold.state === "released" || hold.state === "expired") return;
  if (hold.state === "confirmed") {
    throw new Error("Inventory hold is confirmed and cannot be released");
  }

  const released = (await inventory.releaseHold(holdId)).hold;
  if (released.state === "confirmed") {
    throw new Error("Inventory hold is confirmed and cannot be released");
  }
  if (released.state !== "released" && released.state !== "expired") {
    throw new Error("Inventory service did not release the active hold");
  }
}
