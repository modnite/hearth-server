/**
 * Nudges are meant to be a tap or a few, not a stream: someone's autoclicker once sent fifty thousand in half an hour. Each sender gets a small
 * burst (BURST) that refills at one per REFILL_MS, per room. What goes over is dropped quietly (the sender is not told: a flood gets no feedback).
 */
export const NUDGE_BURST = 5;
export const NUDGE_REFILL_MS = 2000;

interface Bucket {
  tokens: number;
  at: number;
}

const buckets = new Map<string, Bucket>();

/** True when this nudge may go out. [now] is milliseconds. */
export function allowNudge(userId: string, roomId: string, now: number = Date.now()): boolean {
  const key = `${userId}:${roomId}`;
  const b = buckets.get(key) ?? { tokens: NUDGE_BURST, at: now };
  const refilled = Math.min(NUDGE_BURST, b.tokens + Math.max(0, now - b.at) / NUDGE_REFILL_MS);
  if (refilled < 1) {
    buckets.set(key, { tokens: refilled, at: now });
    return false;
  }
  buckets.set(key, { tokens: refilled - 1, at: now });
  if (buckets.size > 5000) for (const [k, v] of buckets) if (now - v.at > 10 * 60_000) buckets.delete(k);
  return true;
}
