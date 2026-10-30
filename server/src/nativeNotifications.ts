import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireUser, tokenFromCookieHeader } from './auth.js';
import { isMember } from './db.js';
import { ackNativeEvents, enqueueNativeNotification, nativeDeviceForToken, nativeDeviceOwnedBy, nativeEvents, nativeWakeup, registerNativeDevice, revokeNativeDevice, type NativeDevice, type NativeEvent } from './nativeQueue.js';

const integer = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const bearer = (req: FastifyRequest) => /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization ?? '')?.[1];

export function registerNativeNotificationRoutes(app: FastifyInstance, ringing: (roomId: string, startedAt: number) => boolean): void {
  const closing = new AbortController();
  const polling = new Set<string>();
  app.addHook('preClose', async () => { closing.abort(); });
  function requireDevice(req: FastifyRequest, reply: FastifyReply): NativeDevice | null {
    reply.header('cache-control', 'no-store');
    const device = nativeDeviceForToken(bearer(req));
    if (!device) reply.code(401).send({ error: 'notification receiver is no longer authorized' });
    return device;
  }

  app.post('/api/native/notifications/register', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const user = requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { deviceId?: unknown; label?: unknown };
    if ((body.deviceId !== undefined && (typeof body.deviceId !== 'string' || body.deviceId.length > 128)) ||
        (body.label !== undefined && typeof body.label !== 'string')) return reply.code(400).send({ error: 'invalid device' });
    try {
      const registered = registerNativeDevice(user.id, tokenFromCookieHeader(req.headers.cookie)!, typeof body.label === 'string' ? body.label : '', body.deviceId as string | undefined);
      if (!registered) return reply.code(401).send({ error: 'sign in again' });
      return registered;
    } catch (err) {
      if ((err as Error).message === 'device belongs to another login') return reply.code(403).send({ error: 'device belongs to another login' });
      throw err;
    }
  });

  app.get('/api/native/notifications/status', async (req, reply) => {
    const d = requireDevice(req, reply);
    if (d) return { deviceId: d.id, userId: d.user_id, cursor: d.last_acked, expiresAt: d.expires_at };
  });

  app.get('/api/native/notifications/events', async (req, reply) => {
    let device = requireDevice(req, reply);
    if (!device) return;
    const q = req.query as { after?: string; wait?: string };
    const after = q.after === undefined ? device.last_acked : /^\d+$/.test(q.after) ? integer(Number(q.after)) : null;
    const wait = q.wait === undefined ? 25 : /^\d+$/.test(q.wait) ? integer(Number(q.wait)) : null;
    if (after === null || after > device.last_delivered || wait === null || wait > 25) return reply.code(400).send({ error: 'invalid cursor or wait' });
    if (polling.has(device.id)) return reply.code(409).send({ error: 'a receiver poll is already open' });
    const pollingId = device.id;
    polling.add(pollingId);
    const disconnected = new AbortController();
    const abort = () => disconnected.abort();
    reply.raw.once('close', abort);
    if (reply.raw.destroyed) abort();
    const signal = AbortSignal.any([closing.signal, disconnected.signal]);
    const wake = nativeWakeup(device.id, signal, wait * 1000);
    const allowed = (event: NativeEvent) => event.kind === 'cancel' ||
      ((!event.payload.roomId || isMember(event.payload.roomId, device!.user_id)) &&
        (!event.payload.tag?.startsWith('call-') ||
          (typeof event.payload.callStartedAt === 'number' && ringing(event.payload.roomId ?? '', event.payload.callStartedAt))));
    try {
      let batch = nativeEvents(device, after, allowed);
      if (batch.events.length === 0 && batch.cursor === after && wait > 0) {
        await wake.promise;
        if (signal.aborted) return reply.code(503).send({ error: 'receiver connection closed' });
        device = nativeDeviceForToken(bearer(req));
        if (!device) return reply.code(401).send({ error: 'notification receiver is no longer authorized' });
        batch = nativeEvents(device, after, allowed);
      }
      return batch;
    } finally {
      wake.close(); polling.delete(pollingId); reply.raw.removeListener('close', abort);
    }
  });

  app.post('/api/native/notifications/ack', async (req, reply) => {
    const d = requireDevice(req, reply);
    if (!d) return;
    const cursor = integer((req.body as { cursor?: unknown } | undefined)?.cursor);
    if (cursor === null || !ackNativeEvents(d, cursor)) return reply.code(400).send({ error: 'cursor was not delivered to this device' });
    return { ok: true };
  });

  app.delete('/api/native/notifications/device', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    let id: string;
    if (req.headers.authorization) {
      const d = requireDevice(req, reply);
      if (!d) return;
      id = d.id;
    } else {
      const user = requireUser(req, reply);
      if (!user) return;
      const deviceId = (req.body as { deviceId?: unknown } | undefined)?.deviceId;
      if (typeof deviceId !== 'string' || !nativeDeviceOwnedBy(deviceId, user.id)) return reply.code(404).send({ error: 'device not found' });
      id = deviceId;
    }
    revokeNativeDevice(id);
    return { ok: true };
  });

  app.post('/api/native/notifications/test', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    let id: string; let userId: string;
    if (req.headers.authorization) {
      const d = requireDevice(req, reply); if (!d) return;
      id = d.id; userId = d.user_id;
    } else {
      const user = requireUser(req, reply); if (!user) return;
      const deviceId = (req.body as { deviceId?: unknown } | undefined)?.deviceId;
      if (typeof deviceId !== 'string' || !nativeDeviceOwnedBy(deviceId, user.id)) return reply.code(404).send({ error: 'device not found' });
      id = deviceId; userId = user.id;
    }
    return { queued: enqueueNativeNotification(userId, { title: 'Hearth', body: 'Native notifications are working.', tag: 'hearth-native-test', url: '/', renotify: true }, id) };
  });
}
