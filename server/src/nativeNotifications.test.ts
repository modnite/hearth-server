import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('./db.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const fs = await import('node:fs');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Exercise the production schema, not a second test-only copy of it.
  const source = fs.readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
  db.exec(source.match(/db\.exec\(`([\s\S]*?)`\);/)![1]!);
  return {
    db, now: () => Date.now(),
    isMember: (room: string, user: string) => Boolean(db.prepare('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?').get(room, user)),
  };
});

import { db } from './db.js';
import { destroySession, purgeExpiredSessions, requireUser } from './auth.js';
import { registerNativeNotificationRoutes } from './nativeNotifications.js';
import { cancelNativeCall, enqueueNativeNotification, NATIVE_QUEUE_LIMIT, NATIVE_QUEUE_TTL } from './nativeQueue.js';
import { pushToUser } from './push.js';

let app: FastifyInstance;
let ringing = true;
const cookie = 'hearth_session=session1';
const otherCookie = 'hearth_session=session2';
const credentials = async (headers = { cookie }, deviceId?: string) => {
  const response = await app.inject({ method: 'POST', url: '/api/native/notifications/register', headers, payload: { label: 'Android test', deviceId } });
  expect(response.statusCode).toBe(200);
  return response.json() as { deviceId: string; userId: string; token: string; cursor: number; expiresAt: number };
};
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const poll = (token: string, after = 0) => app.inject({ url: `/api/native/notifications/events?after=${after}&wait=0`, headers: auth(token) });

beforeEach(async () => {
  db.exec('DELETE FROM users; DELETE FROM rooms;');
  for (const n of [1, 2]) {
    db.prepare('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)').run(`u${n}`, `u${n}`, `User ${n}`, 'not-used', Date.now());
    db.prepare('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(`session${n}`, `u${n}`, Date.now(), Date.now() + 90 * 86400_000);
  }
  db.prepare("INSERT INTO rooms(id,kind,created_at) VALUES('r','dm',?)").run(Date.now());
  db.prepare("INSERT INTO room_members(room_id,user_id,joined_at) VALUES('r','u1',?)").run(Date.now());
  ringing = true;
  app = Fastify({ logger: false });
  registerNativeNotificationRoutes(app, (_room, start) => ringing && start === 123);
  app.get('/session-only', async (req, reply) => requireUser(req, reply));
  app.post('/logout', async (_req, reply) => { destroySession('session1', reply); return { ok: true }; });
  await app.register((await import('@fastify/cookie')).default);
});
afterEach(async () => { await app.close(); vi.restoreAllMocks(); });
afterAll(() => db.close());

describe('native receiver credentials', () => {
  it('requires a login to mint, returns the owner, disables response caching, and stores only a token hash', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/native/notifications/register', payload: {} })).statusCode).toBe(401);
    const response = await app.inject({ method: 'POST', url: '/api/native/notifications/register', headers: { cookie }, payload: {} });
    const d = response.json();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(d).toMatchObject({ userId: 'u1', cursor: 0 });
    expect(d.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = db.prepare('SELECT token_hash,session_token FROM native_notification_devices WHERE id=?').get(d.deviceId) as any;
    expect(row.token_hash).not.toBe(d.token);
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.session_token).toBe('session1');
  });

  it('accepts its bearer only for receiver routes, never ordinary account access or registering another receiver', async () => {
    const d = await credentials();
    expect((await app.inject({ url: '/api/native/notifications/status', headers: auth(d.token) })).json()).toMatchObject({ userId: 'u1', deviceId: d.deviceId });
    expect((await app.inject({ url: '/session-only', headers: auth(d.token) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/native/notifications/register', headers: auth(d.token), payload: {} })).statusCode).toBe(401);
  });

  it('rotates an existing secret while retaining its pending queue and revokes the old secret', async () => {
    const old = await credentials();
    enqueueNativeNotification('u1', { title: 't', body: 'queued' });
    const next = await credentials({ cookie }, old.deviceId);
    expect(next.deviceId).toBe(old.deviceId);
    expect(next.token).not.toBe(old.token);
    expect((await poll(old.token)).statusCode).toBe(401);
    expect((await poll(next.token)).json().events).toHaveLength(1);
  });

  it('cannot rotate, delete, or test another account device', async () => {
    const d = await credentials();
    expect((await app.inject({ method: 'POST', url: '/api/native/notifications/register', headers: { cookie: otherCookie }, payload: { deviceId: d.deviceId } })).statusCode).toBe(403);
    for (const [method, path] of [['DELETE', 'device'], ['POST', 'test']] as const) {
      expect((await app.inject({ method, url: `/api/native/notifications/${path}`, headers: { cookie: otherCookie }, payload: { deviceId: d.deviceId } })).statusCode).toBe(404);
    }
  });

  it('allows bearer self-revocation and removes its durable backlog', async () => {
    const d = await credentials(); enqueueNativeNotification('u1', { title: 't', body: 'b' });
    expect((await app.inject({ method: 'DELETE', url: '/api/native/notifications/device', headers: auth(d.token) })).statusCode).toBe(200);
    expect((await poll(d.token)).statusCode).toBe(401);
    expect(db.prepare('SELECT COUNT(*) AS n FROM native_notification_events').get()).toMatchObject({ n: 0 });
  });

  it('expires with its owning session and is revoked by account logout', async () => {
    const d = await credentials();
    db.prepare("UPDATE sessions SET expires_at=0 WHERE token='session1'").run();
    expect((await poll(d.token)).statusCode).toBe(401);
    purgeExpiredSessions();
    expect(db.prepare('SELECT COUNT(*) AS n FROM native_notification_devices').get()).toMatchObject({ n: 0 });
    const other = await credentials({ cookie: otherCookie });
    destroySession('session2', { clearCookie: () => {} } as any);
    expect((await poll(other.token)).statusCode).toBe(401);
  });

  it('bounds receivers per account and revokes the displaced device', async () => {
    const first = await credentials();
    for (let i = 0; i < 6; i++) await credentials();
    expect(db.prepare("SELECT COUNT(*) AS n FROM native_notification_devices WHERE user_id='u1'").get()).toMatchObject({ n: 6 });
    expect((await poll(first.token)).statusCode).toBe(401);
  });
});

describe('durable native delivery', () => {
  it('queues on every native device even with browser push suppressed, independently of VAPID, with separate acknowledgements', async () => {
    const a = await credentials(); const b = await credentials(); const other = await credentials({ cookie: otherCookie });
    expect((await pushToUser('u1', { title: 'Sender', body: 'message' }, { web: false })).nativeQueued).toBe(2);
    const first = (await poll(a.token)).json();
    expect(first.events).toHaveLength(1);
    expect((await poll(a.token)).json()).toEqual(first); // reconnect replays stable event ids until ACK
    expect((await app.inject({ method: 'POST', url: '/api/native/notifications/ack', headers: auth(a.token), payload: { cursor: first.cursor } })).statusCode).toBe(200);
    expect((await poll(a.token, first.cursor)).json().events).toEqual([]);
    expect((await poll(b.token)).json().events).toHaveLength(1);
    expect((await poll(other.token)).json().events).toEqual([]);
  });

  it('refuses malformed cursors and ACK beyond events actually offered to this receiver', async () => {
    const d = await credentials(); enqueueNativeNotification('u1', { title: 't', body: 'b' });
    const row = db.prepare('SELECT last_enqueued FROM native_notification_devices WHERE id=?').get(d.deviceId) as any;
    expect((await app.inject({ method: 'POST', url: '/api/native/notifications/ack', headers: auth(d.token), payload: { cursor: row.last_enqueued } })).statusCode).toBe(400);
    for (const q of ['after=-1', 'after=999999', 'after=hello', 'wait=26', 'wait=-1']) {
      expect((await app.inject({ url: `/api/native/notifications/events?${q}`, headers: auth(d.token) })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/api/native/notifications/ack', headers: auth(d.token), payload: { cursor: '1' } })).statusCode).toBe(400);
  });

  it('collapses pending room notifications, bounds backlog, and paginates without skipping retained events', async () => {
    const d = await credentials();
    enqueueNativeNotification('u1', { title: 'old', body: 'old', tag: 'same' });
    enqueueNativeNotification('u1', { title: 'new', body: 'new', tag: 'same' });
    expect((await poll(d.token)).json().events.map((e: any) => e.payload.title)).toEqual(['new']);
    for (let i = 0; i <= NATIVE_QUEUE_LIMIT; i++) enqueueNativeNotification('u1', { title: String(i), body: 'b' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM native_notification_events WHERE device_id=?').get(d.deviceId)).toMatchObject({ n: NATIVE_QUEUE_LIMIT });
    let cursor = 0; const titles: string[] = [];
    for (let i = 0; i < 4; i++) {
      const batch = (await poll(d.token, cursor)).json();
      expect(batch.events).toHaveLength(50); cursor = batch.cursor;
      titles.push(...batch.events.map((e: any) => e.payload.title));
    }
    expect(titles).toHaveLength(NATIVE_QUEUE_LIMIT);
    expect(titles[0]).toBe('1'); expect(titles.at(-1)).toBe('200');
  });

  it('expires messages after a day and nudges after a minute while advancing past stale entries', async () => {
    const d = await credentials(); const start = Date.now();
    enqueueNativeNotification('u1', { title: 'message', body: 'b' });
    enqueueNativeNotification('u1', { title: 'nudge', body: 'b', urgent: true });
    vi.spyOn(Date, 'now').mockReturnValue(start + 60_001);
    expect((await poll(d.token)).json().events.map((e: any) => e.payload.title)).toEqual(['message']);
    vi.mocked(Date.now).mockReturnValue(start + NATIVE_QUEUE_TTL + 1);
    const batch = (await poll(d.token)).json(); expect(batch.events).toEqual([]); expect(batch.cursor).toBeGreaterThan(0);
  });

  it('expires rings at thirty seconds and filters rings which were answered or belonged to an earlier server instance', async () => {
    const d = await credentials(); const start = Date.now();
    enqueueNativeNotification('u1', { title: 'ring', body: 'b', roomId: 'r', tag: 'call-r', urgent: true, callStartedAt: 123 });
    expect((await poll(d.token)).json().events).toHaveLength(1);
    ringing = false;
    expect((await poll(d.token)).json().events).toEqual([]);
    ringing = true;
    enqueueNativeNotification('u1', { title: 'ring', body: 'b', roomId: 'r', tag: 'call-r', urgent: true, callStartedAt: 123 });
    vi.spyOn(Date, 'now').mockReturnValue(start + 31_000);
    expect((await poll(d.token)).json().events).toEqual([]);
  });

  it('cancels posted calls and preserves cancel-before-new-ring ordering across reconnects', async () => {
    const d = await credentials();
    const ring = { title: 'ring', body: 'b', roomId: 'r', tag: 'call-r', urgent: true, callStartedAt: 123 };
    enqueueNativeNotification('u1', ring);
    const seen = (await poll(d.token)).json();
    cancelNativeCall('r', ['u1']);
    enqueueNativeNotification('u1', ring);
    const next = (await poll(d.token, seen.cursor)).json();
    expect(next.events.map((e: any) => e.kind)).toEqual(['cancel', 'notification']);
    expect(next.events.every((e: any) => e.payload.tag === 'call-r')).toBe(true);
  });

  it('does not reveal queued room content after membership is removed', async () => {
    const d = await credentials(); enqueueNativeNotification('u1', { title: 'private', body: 'secret', roomId: 'r' });
    db.prepare("DELETE FROM room_members WHERE user_id='u1'").run();
    expect((await poll(d.token)).json().events).toEqual([]);
  });

  it('tests just the selected native device without messaging another account or device', async () => {
    const a = await credentials(); const b = await credentials();
    expect((await app.inject({ method: 'POST', url: '/api/native/notifications/test', headers: auth(a.token) })).json()).toEqual({ queued: 1 });
    expect((await poll(a.token)).json().events).toHaveLength(1);
    expect((await poll(b.token)).json().events).toEqual([]);
  });
});

describe('native long-poll lifecycle', () => {
  const startPoll = async (token: string) => {
    await app.ready();
    const pending = app.inject({ url: '/api/native/notifications/events?after=0&wait=25', headers: auth(token) }).then((r) => r);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { pending };
  };
  it('wakes immediately when an event arrives and rejects a concurrent poll on the same device', async () => {
    const d = await credentials(); const { pending } = await startPoll(d.token);
    expect((await poll(d.token)).statusCode).toBe(409);
    enqueueNativeNotification('u1', { title: 'wake', body: 'b' });
    expect((await pending).json().events[0].payload.title).toBe('wake');
  });
  it('wakes and invalidates an outstanding poll on logout, freeing its slot', async () => {
    const d = await credentials(); const { pending } = await startPoll(d.token);
    await app.inject({ method: 'POST', url: '/logout' });
    expect((await pending).statusCode).toBe(401);
    expect((await poll(d.token)).statusCode).toBe(401);
  });
  it('wakes old credentials on rotation without leaving the receiver poll slot occupied', async () => {
    const old = await credentials(); const { pending } = await startPoll(old.token);
    const next = await credentials({ cookie }, old.deviceId);
    expect((await pending).statusCode).toBe(401);
    expect((await poll(next.token)).statusCode).toBe(200);
  });
  it('drains an outstanding poll during server shutdown', async () => {
    const d = await credentials(); const { pending } = await startPoll(d.token);
    const shutdown = app.close();
    expect((await pending).statusCode).toBe(503);
    await shutdown;
  });
  it('cleans up a disconnected HTTP receiver so it can immediately reconnect', async () => {
    let opened!: () => void; let closed!: () => void;
    const sawRequest = new Promise<void>((resolve) => { opened = resolve; });
    const sawClose = new Promise<void>((resolve) => { closed = resolve; });
    app.addHook('onRequest', async (req, reply) => {
      if (req.url.includes('wait=25')) { reply.raw.once('close', closed); opened(); }
    });
    const d = await credentials();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const receiver = fetch(`${address}/api/native/notifications/events?after=0&wait=25`, { headers: auth(d.token), signal: controller.signal });
    await sawRequest;
    controller.abort();
    await expect(receiver).rejects.toThrow();
    await sawClose;
    expect((await poll(d.token)).statusCode).toBe(200);
  });
});
