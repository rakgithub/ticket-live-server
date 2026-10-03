import { env } from "../config/env.ts";

const activeByUser = new Map<string, number>();

export function acquireUserStream(userId: string): (() => void) | undefined {
  const active = activeByUser.get(userId) ?? 0;
  if (active >= env.EVENT_CHAT_MAX_ACTIVE_PER_USER) return undefined;

  activeByUser.set(userId, active + 1);
  let released = false;

  return () => {
    if (released) return;
    released = true;
    const current = activeByUser.get(userId) ?? 0;
    if (current <= 1) activeByUser.delete(userId);
    else activeByUser.set(userId, current - 1);
  };
}
