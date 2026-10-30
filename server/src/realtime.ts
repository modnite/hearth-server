import { allowNudge } from './nudgeLimit.js';
import { viewersOf, visibleUserIds } from './contacts.js';
import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import { tokenFromCookieHeader, userFromToken } from './auth.js';
import { db, isMember, memberIds, publicUser, type UserRow } from './db.js';
import { pushToUser } from './push.js';
import { cancelNativeCall } from './nativeQueue.js';
import { isActivelyPresent } from './presence.js';
import { media, mediaProbe, mediaRoomName, roomIdFromMediaName } from './media.js';
import { CallStates, callIdentity, stateBelongsTo } from './callState.js';
import {
  CallHealthMonitor,
  normalizeHealth,
  parseHealth,
  type Decision,
  type LiveKitProbe,
  type SeatInput,
} from './callHealth.js';

interface ClientState {
  ws: WebSocket;
  userId: string;
  /** The browser install this socket belongs to. A user may have several. */
  device: string;
  rooms: Set<string>;
  /**
   * Whether this tab is actually on screen. A backgrounded tab still holds its
   * socket, so "connected" is not the same as "in Hearth" — and pushing only to
   * disconnected users means a phone sitting on another app never gets a
   * notification. The client reports this on every visibility change.
   */
  visible: boolean;
}

const nowMs = () => Date.now();
/** Last nudge push per "sender:room", so a nudge cannot be spammed. */
const lastNudge = new Map<string, number>();

interface ActiveCall {
  ringing: boolean;
  startedBy: string;
  startedByName: string;
  startedAt: number;
  participants: Set<string>;
  /** Which devices each participant is in the call from. */
  devices: Map<string, Set<string>>;
  /**
   * Signalled media state, keyed by device identity (`userId:device`) — not by
   * user. Two sessions of one person must not overwrite each other: muting the
   * desktop must not make the phone look (or act) muted, and vice versa.
   */
  states: CallStates;
  /** When each device (`userId:device`) took its seat, for the ghost and watchdog grace. */
  joinedAt: Map<string, number>;
  timer: ReturnType<typeof setTimeout> | null;
  /** Pending end of an emptied call after a dropped connection (a reload or a blip gets this long to come back). */
  emptyTimer?: ReturnType<typeof setTimeout> | null;
  /** True once anyone has been inside the call screen. */
  everJoined: boolean;
}

/** How long a call whose last participant's connection dropped waits for them before it ends. */
const EMPTY_CALL_GRACE_MS = 20_000;

type Frame = Record<string, unknown> & { t: string };

/** The `?device=` the client connected with; `web` if it didn't send one. */
function deviceFromUrl(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return 'web';
  const params = new URLSearchParams(url.slice(q));
  const device = params.get('device');
  return device && device.length <= 64 ? device : 'web';
}

/** How long a user stays "online" after their last socket drops (hides blips). */
const OFFLINE_GRACE_MS = 20_000;
/** Protocol-level ping cadence; keeps proxies from idling sockets out. */
const HEARTBEAT_MS = 25_000;
/** How often a live call is cross-checked against the media engine. */
const HEALTH_CHECK_MS = 10_000;

/**
 * The realtime side: presence, typing, nudges, and fan-out of new messages.
 * One socket per browser, cookie-authenticated on upgrade.
 */
export class Hub {
  private wss = new WebSocketServer({ noServer: true });
  private clients = new Map<WebSocket, ClientState>();
  private byUser = new Map<string, Set<WebSocket>>();
  /** One live call per room: a ring waiting to be answered, then a call people are in. */
  private calls = new Map<string, ActiveCall>();
  /** Users whose last socket just closed; still "online" until the timer fires. */
  private offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthBusy = false;
  private monitor = new CallHealthMonitor();
  private probe: LiveKitProbe = mediaProbe;
  /** `roomId|identity` of legacy clients the bridge holds in the media room: their connection is the bridge's. */
  private bridgeSeats = new Set<string>();
  /** Debug sink for the health cross-check; wired to the app logger at boot. */
  log: { debug: (o: unknown, msg?: string) => void; info: (o: unknown, msg?: string) => void } = {
    debug: () => {},
    info: () => {},
  };

  /** Swap the media probe and the monitor (tests inject fakes here). */
  configureHealth(probe: LiveKitProbe, monitor?: CallHealthMonitor): void {
    this.probe = probe;
    if (monitor) this.monitor = monitor;
  }

  attach(app: FastifyInstance): void {
    app.server.on('upgrade', (req, socket, head) => {
      if (req.url?.startsWith('/legacycall')) {
        if (process.env.LEGACY_BRIDGE === '1') return; // the legacy call bridge (legacyBridge.ts) answers this one
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); // switched off: say so instead of leaving the old PC waiting
        socket.destroy();
        return;
      }
      if (!req.url || !req.url.startsWith('/ws')) {
        socket.destroy();
        return;
      }
      const user = userFromToken(tokenFromCookieHeader(req.headers.cookie));
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const device = deviceFromUrl(req.url);
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, user, device));
    });

    // Keep sockets warm (idle-killing proxies) and reap the dead ones.
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    // Cross-check the signalled mic/cam state against the media engine.
    this.healthTimer = setInterval(() => void this.runHealthCheck(), HEALTH_CHECK_MS);
    this.healthTimer.unref();
    app.server.on('close', () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (this.healthTimer) clearInterval(this.healthTimer);
      this.healthTimer = null;
    });
  }

  /**
   * Adopt calls that are still live on the media engine. Hearth keeps calls in
   * memory, but the SFU keeps the media: after a restart (a deploy, a reboot)
   * the rooms and their participants are still there, so the calls come back
   * instead of being orphaned while the media keeps flowing.
   */
  async restoreCalls(): Promise<number> {
    const rooms = await media.listRooms();
    let restored = 0;
    for (const room of rooms) {
      const roomId = roomIdFromMediaName(room.name);
      if (!roomId || this.calls.has(roomId)) continue;
      const exists = db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId);
      if (!exists) continue;
      const identities = await media.listParticipants(room.name);
      if (identities.length === 0) continue;
      const parsed = identities.map((i) => {
        const at = i.indexOf(':');
        return { user: at === -1 ? i : i.slice(0, at), device: at === -1 ? 'web' : i.slice(at + 1) };
      });
      const devices = new Map<string, Set<string>>();
      for (const p of parsed) {
        const set = devices.get(p.user) ?? new Set<string>();
        set.add(p.device);
        devices.set(p.user, set);
      }
      const startedBy = parsed[0]!.user;
      this.calls.set(roomId, {
        ringing: false,
        startedBy,
        startedByName: this.displayName(startedBy),
        startedAt: room.createdAt ?? Date.now(),
        participants: new Set(devices.keys()),
        devices,
        states: new CallStates(),
        joinedAt: new Map(),
        timer: null,
        everJoined: true,
      });
      const adoptedAt = nowMs();
      for (const p of parsed) this.calls.get(roomId)!.joinedAt.set(callIdentity(p.user, p.device), adoptedAt);
      restored += 1;
      // Tell anyone already connected; they re-report their media states.
      this.broadcastCall(roomId);
    }
    return restored;
  }

  /** Ping every socket; terminate the ones that stopped answering. */
  private heartbeat(): void {
    for (const ws of this.clients.keys()) {
      const tagged = ws as WebSocket & { isAlive?: boolean };
      if (tagged.isAlive === false) {
        ws.terminate();
        continue;
      }
      tagged.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* closing; onClose will clean up */
      }
    }
  }

  private onConnection(ws: WebSocket, user: UserRow, device: string): void {
    const state: ClientState = { ws, userId: user.id, device, rooms: new Set(), visible: true };
    this.clients.set(ws, state);
    if (!this.byUser.has(user.id)) this.byUser.set(user.id, new Set());
    this.byUser.get(user.id)!.add(ws);
    const tagged = ws as WebSocket & { isAlive?: boolean };
    tagged.isAlive = true;
    ws.on('pong', () => {
      tagged.isAlive = true;
    });

    // Back within the grace window: cancel the pending offline flip.
    const pending = this.offlineTimers.get(user.id);
    if (pending) {
      clearTimeout(pending);
      this.offlineTimers.delete(user.id);
    }

    // Coming online: restore the status they last chose (away/busy/invisible)
    // instead of a hard "online".
    const fresh = db
      .prepare('SELECT status, status_preset FROM users WHERE id = ?')
      .get(user.id) as { status: string; status_preset: string } | undefined;
    if (fresh) {
      const preset = ['online', 'away', 'busy', 'invisible'].includes(fresh.status_preset)
        ? fresh.status_preset
        : 'online';
      if (fresh.status !== preset) {
        db.prepare('UPDATE users SET status = ? WHERE id = ?').run(preset, user.id);
      }
    }

    this.send(ws, {
      t: 'ready',
      me: this.selfView(user.id),
      online: this.onlineSnapshot(user.id),
      // The server is the source of truth for calls: a fresh connection adopts
      // exactly these and drops anything it thought was still going.
      calls: [...this.calls.entries()]
        .filter(([callRoom]) => isMember(callRoom, user.id))
        .map(([callRoom, call]) => this.callFrame(callRoom, call)),
    });
    this.broadcastPresence(user.id);

    // If a call is still ringing in one of their rooms, surface the ring too.
    for (const [callRoom, call] of this.calls) {
      if (call.ringing && isMember(callRoom, user.id)) this.send(ws, this.ringFrame(callRoom, call));
    }

    ws.on('message', (raw) => {
      let frame: Frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.onFrame(state, frame);
    });

    ws.on('close', () => this.onClose(state));
    ws.on('error', () => this.onClose(state));
  }

  /** Tell everyone this user changed (profile picture, display name, …). */
  announceUser(userId: string): void {
    this.broadcastPresence(userId);
  }

  private onClose(state: ClientState): void {
    if (!this.clients.has(state.ws)) return;
    this.clients.delete(state.ws);
    const set = this.byUser.get(state.userId);
    set?.delete(state.ws);
    // This browser install is gone (its last socket closed): take just this
    // device out of any call. Other devices of the same user stay in.
    const stillHere = set ? [...set].some((ws) => this.clients.get(ws)?.device === state.device) : false;
    if (!stillHere) this.leaveDevice(state.userId, state.device);
    if (set && set.size === 0) {
      // Keep the (now empty) socket set during a grace window, so a quick
      // reconnect — a phone waking up, a proxy blip — is invisible to
      // everyone instead of flickering offline and back.
      const existing = this.offlineTimers.get(state.userId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.offlineTimers.delete(state.userId);
        const current = this.byUser.get(state.userId);
        if (current && current.size > 0) return; // reconnected in time
        this.byUser.delete(state.userId);
        db.prepare('UPDATE users SET status = ? WHERE id = ?').run('offline', state.userId);
        this.broadcastPresence(state.userId);
      }, OFFLINE_GRACE_MS);
      this.offlineTimers.set(state.userId, timer);
      this.leaveAllCalls(state.userId);
    }
  }

  private onFrame(state: ClientState, frame: Frame): void {
    switch (frame.t) {
      case 'subscribe': {
        const roomId = String(frame.roomId ?? '');
        if (roomId) {
          state.rooms.add(roomId);
          this.send(state.ws, { t: 'subscribed', roomId });
        }
        break;
      }
      case 'typing': {
        const roomId = String(frame.roomId ?? '');
        if (roomId) {
          this.toRoom(
            roomId,
            { t: 'typing', roomId, userId: state.userId, typing: Boolean(frame.typing) },
            state.userId,
          );
        }
        break;
      }
      case 'nudge': {
        const roomId = String(frame.roomId ?? '');
        if (roomId && allowNudge(state.userId, roomId)) {
          this.toRoom(roomId, { t: 'nudge', roomId, userId: state.userId });
          // A nudge is deliberate, so it earns a notification even though
          // messages only push when you are away — but not so deliberate that
          // it can be spammed. One per sender per room per minute.
          const key = `${state.userId}:${roomId}`;
          if (nowMs() - (lastNudge.get(key) ?? 0) > 60_000) {
            lastNudge.set(key, nowMs());
            const sender = db
              .prepare('SELECT display_name FROM users WHERE id = ?')
              .get(state.userId) as { display_name: string } | undefined;
            for (const member of memberIds(roomId)) {
              if (member === state.userId) continue;
              {
                void pushToUser(member, {
                  title: `${sender ? sender.display_name : 'Someone'} nudged you`,
                  body: 'Open Hearth to nudge back.',
                  roomId,
                  url: `/?room=${roomId}`,
                  tag: `nudge-${roomId}`,
                  renotify: true,
                  urgent: true,
                }, { web: !this.isActive(member) });
              }
            }
          }
        }
        break;
      }
      case 'call.start': {
        const roomId = String(frame.roomId ?? '');
        if (roomId) this.startCall(roomId, state.userId, state.device);
        break;
      }
      case 'call.join': {
        const roomId = String(frame.roomId ?? '');
        if (roomId) this.joinCall(roomId, state.userId, state.device);
        break;
      }
      case 'call.leave': {
        const roomId = String(frame.roomId ?? '');
        if (roomId) this.leaveCall(roomId, state.userId, state.device);
        break;
      }
      case 'call.accept': {
        const roomId = String(frame.roomId ?? '');
        if (roomId) this.acceptCall(roomId, state.userId, state.device);
        break;
      }
      case 'call.decline': {
        const roomId = String(frame.roomId ?? '');
        if (roomId) this.declineCall(roomId, state.userId);
        break;
      }
      case 'call.end': {
        const roomId = String(frame.roomId ?? '');
        if (roomId) this.endCall(roomId, state.userId);
        break;
      }
      case 'call.state': {
        const roomId = String(frame.roomId ?? '');
        if (roomId) this.callState(roomId, state.userId, state.device, frame);
        break;
      }
      case 'presence.set': {
        const status = String(frame.status ?? 'online');
        const message = String(frame.statusMessage ?? '');
        const allowed = ['online', 'away', 'busy', 'invisible'];
        if (allowed.includes(status)) {
          db.prepare(
            'UPDATE users SET status = ?, status_preset = ?, status_message = ? WHERE id = ?',
          ).run(status, status, message.slice(0, 160), state.userId);
          this.broadcastPresence(state.userId);
        }
        break;
      }
      case 'presence.visibility': {
        // Whether this tab is on screen. Only the socket that reported it: a
        // user may have one tab visible and another in the background.
        state.visible = frame.visible !== false;
        break;
      }
    }
  }

  // ---- calls: a ring, then a live call ----

  private displayName(userId: string): string {
    const row = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId) as
      | { display_name: string }
      | undefined;
    return row?.display_name ?? 'Someone';
  }

  private callFrame(roomId: string, call: ActiveCall): Record<string, unknown> {
    return {
      t: 'call.active',
      roomId,
      ringing: call.ringing,
      startedBy: call.startedBy,
      startedByName: call.startedByName,
      startedAt: call.startedAt,
      participants: [...call.participants],
      states: call.states.toJSON(),
    };
  }

  private ringFrame(roomId: string, call: ActiveCall): Record<string, unknown> {
    return {
      t: 'call.ring',
      roomId,
      fromUserId: call.startedBy,
      fromName: call.startedByName,
      startedAt: call.startedAt,
    };
  }

  private broadcastCall(roomId: string): void {
    const call = this.calls.get(roomId);
    if (call) this.toRoom(roomId, this.callFrame(roomId, call));
  }

  private startCall(roomId: string, userId: string, device: string): void {
    if (!isMember(roomId, userId)) return;

    const existing = this.calls.get(roomId);
    if (existing) {
      // Already going: make sure this client sees the state, and re-ring if still ringing.
      this.addDevice(existing, userId, device);
      this.toUser(userId, this.callFrame(roomId, existing));
      if (existing.ringing) this.toRoom(roomId, this.ringFrame(roomId, existing), userId);
      return;
    }

    const call: ActiveCall = {
      ringing: true,
      startedBy: userId,
      startedByName: this.displayName(userId),
      startedAt: Date.now(),
      participants: new Set(),
      devices: new Map(),
      states: new CallStates(),
      joinedAt: new Map(),
      timer: null,
      everJoined: false,
    };
    call.timer = setTimeout(() => this.ringTimedOut(roomId), 30_000);
    this.log.info({ roomId, startedBy: userId }, 'ringing started');
    this.calls.set(roomId, call);

    this.toRoom(roomId, this.ringFrame(roomId, call), userId);
    this.toUser(userId, this.callFrame(roomId, call));

    for (const member of memberIds(roomId)) {
      if (member === userId) continue;
      {
        void pushToUser(member, {
          title: `${call.startedByName} is calling`,
          body: 'Tap to join the call',
          roomId,
          url: `/?room=${roomId}`,
          tag: `call-${roomId}`,
          renotify: true,
          urgent: true,
          callStartedAt: call.startedAt,
          callExpiresAt: call.startedAt + 30_000,
        }, { web: !this.isActive(member) });
      }
    }
  }

  /** Nobody answered in time: stop ringing, but keep the call if anyone's still in it. */
  private ringTimedOut(roomId: string): void {
    const call = this.calls.get(roomId);
    if (!call || !call.ringing) return;
    call.ringing = false;
    call.timer = null;
    cancelNativeCall(roomId, memberIds(roomId));
    this.toRoom(roomId, { t: 'call.ring.stop', roomId });
    if (call.participants.size === 0) void this.endIfEmpty(roomId, call, 'nobody joined the ring');
    else this.broadcastCall(roomId);
  }

  /** Being in the call answers a ring from someone else. The starter's own join is not an answer. */
  private answerRing(roomId: string, call: ActiveCall, userId: string): void {
    if (call.startedBy !== userId) this.stopRinging(roomId, call);
  }

  /** Record that a device is in the call. A user can be in from several. */
  private addDevice(call: ActiveCall, userId: string, device: string): void {
    call.participants.add(userId);
    if (call.emptyTimer) {
      clearTimeout(call.emptyTimer);
      call.emptyTimer = null;
    }
    const set = call.devices.get(userId) ?? new Set<string>();
    set.add(device);
    call.devices.set(userId, set);
    const id = callIdentity(userId, device);
    if (!call.joinedAt.has(id)) call.joinedAt.set(id, nowMs());
  }

  /**
   * Drop one device. The user leaves the call only when their last device is
   * gone — hanging up on the phone must not remove them on the desktop.
   */
  private removeDevice(call: ActiveCall, userId: string, device: string): boolean {
    // The device that left is out of the call either way, so its signalled state
    // goes with it — otherwise a stale screen-share flag keeps the room "sharing"
    // and a stale mic flag misreports them. Other devices keep their own state.
    call.states.deleteDevice(userId, device);
    call.joinedAt.delete(callIdentity(userId, device));
    const set = call.devices.get(userId);
    if (set) {
      set.delete(device);
      if (set.size > 0) return false;
      call.devices.delete(userId);
    }
    call.participants.delete(userId);
    return true;
  }

  /** Someone answered: stop ringing everyone, mark the call live. */
  private acceptCall(roomId: string, userId: string, device: string): void {
    if (!isMember(roomId, userId)) return;
    const call = this.ensureCall(roomId, userId);
    this.stopRinging(roomId, call);
    this.addDevice(call, userId, device);
    call.everJoined = true;
    this.toRoom(roomId, { t: 'call.accepted', roomId, userId });
    this.broadcastCall(roomId);
  }

  /** Someone opened the call screen (including whoever started it). */
  private joinCall(roomId: string, userId: string, device: string): void {
    if (!isMember(roomId, userId)) return;
    const call = this.ensureCall(roomId, userId);
    this.addDevice(call, userId, device);
    call.everJoined = true;
    this.answerRing(roomId, call, userId);
    this.broadcastCall(roomId);
  }

  private leaveCall(roomId: string, userId: string, device: string): void {
    const call = this.calls.get(roomId);
    if (!call) return;
    this.removeDevice(call, userId, device);
    // A stale hub roster must not end somebody else's media connection.
    // Explicit "End for everyone" remains immediate; ordinary Leave checks
    // the actual media room, including bridge participants, before ending it.
    if (call.participants.size === 0) {
      void this.endIfEmpty(roomId, call, 'last person left');
      return;
    }
    this.broadcastCall(roomId);
  }

  /**
   * A legacy (XP-era) client joined the call's media room through the bridge. The bridge is a
   * LiveKit participant, not a websocket client, so it never sends call.join; without this the
   * hub would not count that person and would end the call for them the moment the last web
   * client left.
   */
  legacyJoin(roomId: string, userId: string, device: string): void {
    if (!isMember(roomId, userId)) return;
    const call = this.ensureCall(roomId, userId);
    this.addDevice(call, userId, device);
    call.everJoined = true;
    this.bridgeSeats.add(`${roomId}|${callIdentity(userId, device)}`);
    this.answerRing(roomId, call, userId);
    this.broadcastCall(roomId);
  }

  /** A legacy client's connection ended: retract its seat, and end the call only if nobody is left. */
  legacyLeave(roomId: string, userId: string, device: string): void {
    const call = this.calls.get(roomId);
    this.bridgeSeats.delete(`${roomId}|${callIdentity(userId, device)}`);
    if (!call) return;
    this.removeDevice(call, userId, device);
    if (call.participants.size === 0) {
      // A bridge connection can drop on a network blip: give it the same grace as a reload.
      this.endCallAfterGrace(roomId, call, 'bridge dropped');
      return;
    }
    this.broadcastCall(roomId);
  }

  private declineCall(roomId: string, userId: string): void {
    this.toRoom(roomId, { t: 'call.declined', roomId, userId }, userId);
  }

  private endCallAfterGrace(roomId: string, call: ActiveCall, reason = 'connection dropped'): void {
    if (call.emptyTimer) return;
    call.emptyTimer = setTimeout(() => {
      call.emptyTimer = null;
      void this.endIfEmpty(roomId, call, reason);
    }, EMPTY_CALL_GRACE_MS);
  }

  /** Whether anyone is still in the call's media room. null = the media engine could not be asked. */
  private async mediaRoomOccupied(roomId: string): Promise<boolean | null> {
    try {
      const people = await this.probe.inspectRoom(mediaRoomName(roomId));
      return people === null ? null : people.length > 0;
    } catch {
      return null;
    }
  }

  /**
   * An involuntary end (a dropped socket, a seat released, a ring nobody answered) ends the call
   * only when the media room is empty too. The hub's own seat list can lag or lose someone; LiveKit
   * is what really holds the call. If LiveKit still has people, or cannot be asked, the call stays
   * open and is looked at again later.
   */
  private async endIfEmpty(roomId: string, call: ActiveCall, reason: string): Promise<void> {
    if (this.calls.get(roomId) !== call || call.participants.size > 0) return;
    const occupied = await this.mediaRoomOccupied(roomId);
    if (this.calls.get(roomId) !== call || call.participants.size > 0) return;
    if (occupied === false) {
      this.endCall(roomId, undefined, reason);
      return;
    }
    this.log.info({ roomId, reason, occupied }, 'call kept: the media room is not empty');
    if (!call.emptyTimer) {
      call.emptyTimer = setTimeout(() => {
        call.emptyTimer = null;
        void this.endIfEmpty(roomId, call, reason);
      }, EMPTY_CALL_GRACE_MS);
    }
  }

  private endCall(roomId: string, userId?: string, reason = 'ended for everyone'): void {
    if (userId && !isMember(roomId, userId)) return;
    const call = this.calls.get(roomId);
    if (!call) return;
    cancelNativeCall(roomId, memberIds(roomId));
    if (call.timer) clearTimeout(call.timer);
    if (call.emptyTimer) clearTimeout(call.emptyTimer);
    this.log.info({ roomId, by: userId ?? 'system', reason, had: call.participants.size }, 'call ended');
    for (const key of [...this.bridgeSeats]) if (key.startsWith(`${roomId}|`)) this.bridgeSeats.delete(key);
    this.calls.delete(roomId);
    this.monitor.forgetRoom(roomId);
    this.toRoom(roomId, { t: 'call.end', roomId });
  }

  private ensureCall(roomId: string, userId: string): ActiveCall {
    let call = this.calls.get(roomId);
    if (!call) {
      call = {
        ringing: false,
        startedBy: userId,
        startedByName: this.displayName(userId),
        startedAt: Date.now(),
        participants: new Set(),
        devices: new Map(),
        states: new CallStates(),
        joinedAt: new Map(),
        timer: null,
        everJoined: false,
      };
      this.calls.set(roomId, call);
    }
    return call;
  }

  /** A participant reports its mic/camera/screen state; relayed in call.active.
   *  Stored per device so a person's other sessions keep their own state. */
  private callState(
    roomId: string,
    userId: string,
    device: string,
    frame: Record<string, unknown>,
  ): void {
    const call = this.calls.get(roomId);
    if (!call || !call.participants.has(userId)) return;
    const mic = Boolean(frame.mic);
    const cam = Boolean(frame.cam);
    call.states.set(userId, device, {
      mic,
      cam,
      screen: Boolean(frame.screen),
      // Optional and additive: old clients send neither and get plain on/off.
      health: normalizeHealth({ mic, cam }, parseHealth(frame.health)),
      reportAt: nowMs(),
    });
    this.broadcastCall(roomId);
  }

  private hasSocket(userId: string, device: string): boolean {
    for (const ws of this.byUser.get(userId) ?? []) {
      if (this.clients.get(ws)?.device === device) return true;
    }
    return false;
  }

  /**
   * Cross-check every live call against what the media engine really sees,
   * fix what the signalled state got wrong, and release dead seats. Safe to
   * call at any time; overlapping runs are skipped. Resolves once done.
   */
  async runHealthCheck(): Promise<void> {
    if (this.healthBusy) return;
    this.healthBusy = true;
    try {
      for (const [roomId, call] of [...this.calls]) {
        if (call.participants.size === 0) continue;
        const seats: SeatInput[] = [];
        for (const [userId, devices] of call.devices) {
          for (const device of devices) {
            const identity = callIdentity(userId, device);
            seats.push({
              userId,
              device,
              identity,
              state: call.states.get(userId, device),
              joinedAt: call.joinedAt.get(identity) ?? nowMs(),
              // A legacy seat has no socket of its own; the bridge holding it is its connection.
              hasSocket: this.hasSocket(userId, device) || this.bridgeSeats.has(`${roomId}|${identity}`),
            });
          }
        }
        let lk;
        try {
          lk = await this.probe.inspectRoom(mediaRoomName(roomId));
        } catch {
          lk = null;
        }
        // The call may have changed while we waited on the media engine.
        if (this.calls.get(roomId) !== call) continue;
        // A resumed client can report healthy media or reconnect during the
        // probe. Never overwrite that newer report with an older snapshot, or
        // release a seat whose connection recovered while the request waited.
        const unchanged = seats.filter((s) =>
          call.devices.get(s.userId)?.has(s.device) &&
          call.joinedAt.get(s.identity) === s.joinedAt &&
          call.states.get(s.userId, s.device) === s.state &&
          (this.hasSocket(s.userId, s.device) || this.bridgeSeats.has(`${roomId}|${s.identity}`)) === s.hasSocket,
        );
        await this.applyDecision(roomId, call, this.monitor.evaluate(roomId, unchanged, lk));
      }
    } finally {
      this.healthBusy = false;
    }
  }

  private async applyDecision(roomId: string, call: ActiveCall, d: Decision): Promise<void> {
    let changed = false;
    for (const r of d.releases) {
      if (!call.devices.get(r.userId)?.has(r.device)) continue;
      this.log.debug({ roomId, identity: r.identity, why: r.reason }, 'call health: releasing seat');
      this.removeDevice(call, r.userId, r.device);
      this.monitor.forgetSeat(roomId, r.identity);
      changed = true;
    }
    for (const c of d.corrections) {
      const cur = call.states.get(c.userId, c.device);
      if (!cur || !call.devices.get(c.userId)?.has(c.device)) continue;
      const next = { ...cur, [c.kind]: c.value };
      if (c.kind !== 'screen') {
        const health = normalizeHealth(next, {
          mic: (cur.health?.mic ?? 'off') as never,
          cam: (cur.health?.cam ?? 'off') as never,
        });
        // Signalled on, nothing live: interrupted. Signalled off, but live: on.
        health[c.kind] = c.value ? 'on' : 'interrupted';
        next.health = health;
      }
      next.corrected = { at: nowMs(), by: 'livekit', reason: c.reason };
      call.states.set(c.userId, c.device, next);
      this.log.debug({ roomId, identity: c.identity, kind: c.kind, now: c.value, why: c.reason }, 'call health: corrected');
      changed = true;
    }
    if (!this.calls.has(roomId)) return;
    if (call.participants.size === 0) {
      await this.endIfEmpty(roomId, call, 'media seats released');
      return;
    }
    if (changed) this.broadcastCall(roomId);
  }

  private stopRinging(roomId: string, call: ActiveCall): void {
    if (call.timer) {
      clearTimeout(call.timer);
      call.timer = null;
    }
    if (call.ringing) {
      call.ringing = false;
      cancelNativeCall(roomId, memberIds(roomId));
      this.log.info({ roomId, startedBy: call.startedBy, participants: call.participants.size }, 'ringing stopped');
      this.toRoom(roomId, { t: 'call.ring.stop', roomId });
    }
  }

  /** One browser install went away: retract only that device's call seats. */
  private leaveDevice(userId: string, device: string): void {
    for (const [roomId, call] of [...this.calls]) {
      if (!call.participants.has(userId)) continue;
      this.removeDevice(call, userId, device);
      if (call.participants.size === 0) {
        // The connection dropped (not a Leave press): give a reload or a blip a moment to come back.
        this.endCallAfterGrace(roomId, call);
      }
      this.broadcastCall(roomId);
    }
  }

  /** Clean up everything an offline user was part of (their last socket went). */
  private leaveAllCalls(userId: string): void {
    for (const [roomId, call] of [...this.calls]) {
      if (call.participants.has(userId)) {
        call.participants.delete(userId);
        call.devices.delete(userId);
        call.states.deleteUser(userId);
        for (const key of [...call.joinedAt.keys()]) if (stateBelongsTo(key, userId)) call.joinedAt.delete(key);
        // The last person's connection dropped: a reload or a network blip gets a short
        // grace to come back before the empty call ends for everyone.
        if (call.participants.size === 0) {
          this.endCallAfterGrace(roomId, call);
          continue;
        }
      }
      if (call.startedBy === userId) this.stopRinging(roomId, call);
      this.broadcastCall(roomId);
    }
  }

  // ---- fan-out helpers used by HTTP routes ----

  send(ws: WebSocket, obj: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  toUser(userId: string, obj: unknown): void {
    for (const ws of this.byUser.get(userId) ?? []) this.send(ws, obj);
  }

  toRoom(roomId: string, obj: unknown, exceptUserId?: string): void {
    const members = new Set(memberIds(roomId));
    for (const [ws, state] of this.clients) {
      if (!members.has(state.userId)) continue;
      if (exceptUserId && state.userId === exceptUserId) continue;
      this.send(ws, obj);
    }
  }

  broadcastAll(obj: unknown): void {
    for (const ws of this.clients.keys()) this.send(ws, obj);
  }

  /** Presence and profile changes go only to the people who may see this user (contacts and people in a chat with them). */
  broadcastPresence(userId: string): void {
    const view = this.presented(userId);
    if (!view) return;
    const viewers = viewersOf(userId);
    for (const [ws, state] of this.clients) if (viewers.has(state.userId)) this.send(ws, { t: 'presence', user: view });
  }

  isOnline(userId: string): boolean {
    return this.byUser.has(userId);
  }

  /** Native notification backlogs must match this exact still-ringing call. */
  isRinging(roomId: string, startedAt: number): boolean {
    const call = this.calls.get(roomId);
    return Boolean(call?.ringing && call.startedAt === startedAt);
  }

  /**
   * In Hearth *and looking at it*. This is what decides whether a push is worth
   * sending: a tab in the background, or a phone on another app, should be
   * notified rather than stay silent because its socket is still open.
   */
  isActive(userId: string): boolean {
    const sockets = this.byUser.get(userId);
    if (!sockets) return false;
    const states: { visible: boolean }[] = [];
    for (const ws of sockets) {
      const state = this.clients.get(ws);
      if (state) states.push(state);
    }
    return isActivelyPresent(states);
  }

  onlineUserIds(): string[] {
    return [...this.byUser.keys()];
  }

  private onlineSnapshot(viewerId: string) {
    const visible = visibleUserIds(viewerId);
    const ids = this.onlineUserIds().filter((id) => visible.has(id));
    if (ids.length === 0) return [];
    const rows = db
      .prepare(`SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as UserRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter(Boolean).map((u) => this.present(u as UserRow));
  }

  private selfView(userId: string) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow;
    return { ...publicUser(u) };
  }

  private presented(userId: string) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
    return u ? this.present(u) : null;
  }

  private present(u: UserRow) {
    const base = publicUser(u);
    return { ...base, status: base.status === 'invisible' ? 'offline' : base.status };
  }
}

export const hub = new Hub();
