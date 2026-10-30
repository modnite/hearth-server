import crypto from 'node:crypto';
import { db, now } from './db.js';
import { env } from './env.js';
import { enqueueNativeNotification } from './nativeQueue.js';

let ready = false;
let initFailed = false;

/** Set up web-push once. A bad VAPID key must never take the server down: it is
 *  logged once, and push is simply off until it is fixed. */
async function ensureInit(): Promise<boolean> {
  if (ready) return true;
  if (initFailed) return false;
  try {
    const webpush = (await import('web-push')).default;
    webpush.setVapidDetails(
      env.VAPID_SUBJECT || `mailto:admin@${env.HEARTH_DOMAIN}`,
      env.VAPID_PUBLIC_KEY,
      env.VAPID_PRIVATE_KEY,
    );
    ready = true;
  } catch (err) {
    initFailed = true;
    console.error(`push disabled: the VAPID keys are not usable (${(err as Error).message})`);
  }
  return ready;
}

export const pushEnabled = () => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) && !initFailed;
export const pushPublicKey = () => env.VAPID_PUBLIC_KEY;

/** A device is only worth keeping the newest few of: a browser re-subscribes with
 *  a new endpoint now and then, and the old ones are dead weight. */
const MAX_SUBSCRIPTIONS_PER_USER = 6;

export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Is this a subscription we can actually send to? */
export function isValidSubscription(sub: unknown): sub is SubscriptionInput {
  const s = sub as Partial<SubscriptionInput> | null | undefined;
  return Boolean(
    s &&
      typeof s.endpoint === 'string' &&
      /^https:\/\//.test(s.endpoint) &&
      s.endpoint.length < 2048 &&
      typeof s.keys?.p256dh === 'string' &&
      s.keys.p256dh.length > 20 &&
      typeof s.keys?.auth === 'string' &&
      s.keys.auth.length > 8,
  );
}

export function saveSubscription(userId: string, sub: SubscriptionInput): void {
  // Re-registering the same endpoint refreshes its keys and its owner: that is
  // what heals a device that changed hands (another person signing in on it) or
  // whose browser rotated its keys.
  db.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       created_at = excluded.created_at`,
  ).run(crypto.randomUUID(), userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, now());
  db.prepare(
    `DELETE FROM push_subscriptions
      WHERE user_id = ? AND id NOT IN (
        SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
      )`,
  ).run(userId, userId, MAX_SUBSCRIPTIONS_PER_USER);
}

export function removeSubscription(endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

/** Does this user have this exact device registered? */
export function subscriptionStatus(userId: string, endpoint?: string): { count: number; registered: boolean } {
  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId) as { n: number }
  ).n;
  const registered = endpoint
    ? Boolean(
        db
          .prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
          .get(userId, endpoint),
      )
    : false;
  return { count, registered };
}

export interface PushPayload {
  title: string;
  body: string;
  roomId?: string;
  tag?: string;
  url?: string;
  /** Buzz again even if a notification with this tag is already showing. */
  renotify?: boolean;
  /** A ring or a nudge: wake the phone now and keep it on screen until acted on. */
  urgent?: boolean;
  /** How many unread messages this notification stands for. */
  count?: number;
  /** A ring instance and its deadline; native backlog never replays an old call. */
  callStartedAt?: number;
  callExpiresAt?: number;
}

/** How the push service should treat a message: how long to keep it if the
 *  device is off, how urgently to wake it, and which pending pushes it replaces. */
export function buildSendOptions(p: PushPayload): {
  TTL: number;
  urgency: 'high' | 'normal';
  topic?: string;
} {
  return {
    // A ring is stale in a minute; a message is still worth showing tomorrow.
    TTL: p.urgent ? 60 : 24 * 60 * 60,
    urgency: p.urgent ? 'high' : 'normal',
    // The push service keeps only the newest undelivered push per topic, so a
    // phone that was off does not wake to a pile of messages from one room.
    topic: p.tag ? crypto.createHash('sha1').update(p.tag).digest('base64url').slice(0, 32) : undefined,
  };
}

export interface PushResult {
  sent: number;
  failed: number;
  pruned: number;
  nativeQueued?: number;
  /** Why nothing was sent, when that is not simply "no devices". */
  error?: string;
}

/** Best-effort, and never throws: a dead subscription is pruned and anything else
 *  is logged. Callers fire this and forget it, so an exception here would be an
 *  unhandled rejection. */
export async function pushToUser(userId: string, payload: PushPayload, delivery: { web?: boolean } = {}): Promise<PushResult> {
  const result: PushResult = { sent: 0, failed: 0, pruned: 0 };
  try {
    // Native receivers are independent of VAPID and another device's presence.
    result.nativeQueued = enqueueNativeNotification(userId, payload);
    if (delivery.web === false) return result;
    if (!pushEnabled()) return { ...result, error: 'push is not configured on this server' };
    if (!(await ensureInit())) return { ...result, error: 'the server push keys are not usable' };
    const webpush = (await import('web-push')).default;
    const subs = db
      .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
      .all(userId) as { endpoint: string; p256dh: string; auth: string }[];
    if (subs.length === 0) return result;

    const options = buildSendOptions(payload);
    await Promise.allSettled(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify(payload),
            options,
          );
          result.sent += 1;
        } catch (err: unknown) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            removeSubscription(s.endpoint);
            result.pruned += 1;
            return;
          }
          result.failed += 1;
          // Say what the push service said: a silent failure is how "push does
          // not work" becomes undiagnosable.
          console.warn(
            `push failed for ${userId}: ${status ?? ''} ${(err as Error).message ?? String(err)}`,
          );
        }
      }),
    );
    if (result.sent > 0 || result.pruned > 0) {
      console.info(
        `push: ${result.sent} sent, ${result.failed} failed, ${result.pruned} dead removed for ${userId}`,
      );
    }
  } catch (err) {
    console.error(`push error for ${userId}: ${(err as Error).message ?? String(err)}`);
    return { ...result, error: (err as Error).message ?? String(err) };
  }
  return result;
}
