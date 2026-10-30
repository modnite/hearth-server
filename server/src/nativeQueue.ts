import crypto from 'node:crypto';
import { db, now } from './db.js';
import type { PushPayload } from './push.js';

export const NATIVE_QUEUE_LIMIT = 200;
export const NATIVE_QUEUE_TTL = 24 * 60 * 60_000;
const MAX_DEVICES = 6;
const listeners = new Map<string, Set<() => void>>();

export interface NativeDevice {
  id: string; user_id: string; session_token: string; expires_at: number;
  last_enqueued: number; last_delivered: number; last_acked: number;
}
export interface NativeEvent {
  id: number; kind: 'notification' | 'cancel'; createdAt: number; expiresAt: number; payload: PushPayload;
}
const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const wake = (id: string) => { for (const fn of [...(listeners.get(id) ?? [])]) fn(); };

export function purgeNativeNotifications(): void {
  db.prepare('DELETE FROM native_notification_events WHERE expires_at <= ?').run(now());
  db.prepare('DELETE FROM native_notification_devices WHERE expires_at <= ?').run(now());
}

export function registerNativeDevice(userId: string, session: string, label: string, deviceId?: string) {
  purgeNativeNotifications();
  const login = db.prepare('SELECT expires_at FROM sessions WHERE token = ? AND user_id = ? AND expires_at > ?')
    .get(session, userId, now()) as { expires_at: number } | undefined;
  if (!login) return null;
  const old = deviceId ? db.prepare('SELECT * FROM native_notification_devices WHERE id = ?').get(deviceId) as NativeDevice | undefined : undefined;
  if (old && (old.user_id !== userId || old.session_token !== session)) throw new Error('device belongs to another login');
  const id = old?.id ?? crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO native_notification_devices (id,user_id,session_token,token_hash,label,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,label=excluded.label,created_at=excluded.created_at,expires_at=excluded.expires_at`)
    .run(id, userId, session, hash(token), label.slice(0, 80), now(), login.expires_at);
  const removed = db.prepare(`SELECT id FROM native_notification_devices WHERE user_id=? AND id NOT IN
    (SELECT id FROM native_notification_devices WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?)`)
    .all(userId, userId, MAX_DEVICES) as { id: string }[];
  for (const d of removed) revokeNativeDevice(d.id);
  wake(id); // a poll using the old secret must reauthenticate after rotation
  return { deviceId: id, userId, token, cursor: old?.last_acked ?? 0, expiresAt: login.expires_at };
}

export function nativeDeviceForToken(token: string | undefined): NativeDevice | null {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.prepare(`SELECT d.* FROM native_notification_devices d JOIN sessions s ON s.token=d.session_token
    WHERE d.token_hash=? AND d.expires_at>? AND s.expires_at>?`)
    .get(hash(token), now(), now()) as NativeDevice | undefined ?? null;
}

export function nativeDeviceOwnedBy(id: string, userId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM native_notification_devices WHERE id=? AND user_id=? AND expires_at>?').get(id, userId, now()));
}

export function revokeNativeDevice(id: string): void {
  db.prepare('DELETE FROM native_notification_devices WHERE id=?').run(id);
  wake(id);
}

export function revokeNativeSession(session: string): void {
  const ids = db.prepare('SELECT id FROM native_notification_devices WHERE session_token=?').all(session) as { id: string }[];
  for (const d of ids) revokeNativeDevice(d.id);
}

function insert(id: string, kind: NativeEvent['kind'], payload: PushPayload, expiresAt: number): void {
  const tag = payload.tag ?? '';
  // Replace only pending notifications. A cancellation must survive until ACK,
  // even when a newer call in this room is queued immediately afterwards.
  if (tag) db.prepare("DELETE FROM native_notification_events WHERE device_id=? AND tag=? AND kind='notification'").run(id, tag);
  const result = db.prepare('INSERT INTO native_notification_events(device_id,kind,tag,payload,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    .run(id, kind, tag, JSON.stringify(payload), now(), expiresAt);
  db.prepare('UPDATE native_notification_devices SET last_enqueued=? WHERE id=?').run(Number(result.lastInsertRowid), id);
  db.prepare(`DELETE FROM native_notification_events WHERE device_id=? AND id NOT IN
    (SELECT id FROM native_notification_events WHERE device_id=? ORDER BY id DESC LIMIT ?)`)
    .run(id, id, NATIVE_QUEUE_LIMIT);
}

export function enqueueNativeNotification(userId: string, payload: PushPayload, onlyDevice?: string): number {
  const devices = db.prepare(`SELECT d.id FROM native_notification_devices d JOIN sessions s ON s.token=d.session_token
    WHERE d.user_id=? AND d.expires_at>? AND s.expires_at>?`).all(userId, now(), now()) as { id: string }[];
  const ids = devices.filter((d) => !onlyDevice || d.id === onlyDevice).map((d) => d.id);
  if (ids.length === 0) return 0;
  const expires = payload.tag?.startsWith('call-')
    ? Math.min(now() + 30_000, payload.callExpiresAt ?? now() + 30_000)
    : now() + (payload.urgent ? 60_000 : NATIVE_QUEUE_TTL);
  if (expires <= now()) return 0;
  db.transaction(() => { for (const id of ids) insert(id, 'notification', payload, expires); })();
  for (const id of ids) wake(id);
  return ids.length;
}

/** Dismiss already posted notifications as well as deleting queued rings. */
export function cancelNativeCall(roomId: string, userIds: string[]): void {
  const ids: string[] = [];
  db.transaction(() => {
    for (const userId of userIds) {
      const devices = db.prepare('SELECT id FROM native_notification_devices WHERE user_id=? AND expires_at>?')
        .all(userId, now()) as { id: string }[];
      for (const d of devices) {
        insert(d.id, 'cancel', { title: '', body: '', roomId, tag: `call-${roomId}` }, now() + NATIVE_QUEUE_TTL);
        ids.push(d.id);
      }
    }
  })();
  for (const id of ids) wake(id);
}

export function nativeEvents(device: NativeDevice, after: number, allowed: (event: NativeEvent) => boolean): { events: NativeEvent[]; cursor: number } {
  const from = Math.max(after, device.last_acked);
  const rows = db.prepare('SELECT * FROM native_notification_events WHERE device_id=? AND id>? ORDER BY id LIMIT 50')
    .all(device.id, from) as { id: number; kind: NativeEvent['kind']; payload: string; created_at: number; expires_at: number }[];
  const events: NativeEvent[] = [];
  for (const row of rows) {
    const event = { id: row.id, kind: row.kind, payload: JSON.parse(row.payload) as PushPayload, createdAt: row.created_at, expiresAt: row.expires_at };
    if (event.expiresAt > now() && allowed(event)) events.push(event);
    else db.prepare('DELETE FROM native_notification_events WHERE id=? AND device_id=?').run(row.id, device.id);
  }
  const cursor = rows.at(-1)?.id ?? Math.max(from, device.last_enqueued);
  db.prepare('UPDATE native_notification_devices SET last_delivered=MAX(last_delivered,?) WHERE id=?').run(cursor, device.id);
  return { events, cursor };
}

export function ackNativeEvents(device: NativeDevice, cursor: number): boolean {
  if (cursor > device.last_delivered) return false;
  db.transaction(() => {
    db.prepare('UPDATE native_notification_devices SET last_acked=MAX(last_acked,?) WHERE id=?').run(cursor, device.id);
    db.prepare('DELETE FROM native_notification_events WHERE device_id=? AND id<=?').run(device.id, cursor);
  })();
  return true;
}

/** Subscribed before querying, so an enqueue between query and await cannot be lost. */
export function nativeWakeup(deviceId: string, signal: AbortSignal, timeoutMs: number) {
  let resolve!: () => void;
  let finished = false;
  const promise = new Promise<void>((r) => { resolve = r; });
  const finish = () => { if (!finished) { finished = true; resolve(); } };
  const set = listeners.get(deviceId) ?? new Set<() => void>();
  set.add(finish); listeners.set(deviceId, set);
  signal.addEventListener('abort', finish, { once: true });
  const timer = setTimeout(finish, timeoutMs);
  if (signal.aborted) finish();
  return { promise, close: () => {
    clearTimeout(timer); signal.removeEventListener('abort', finish); set.delete(finish);
    if (set.size === 0) listeners.delete(deviceId);
  } };
}
