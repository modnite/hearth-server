import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import { tokenFromCookieHeader, userFromToken } from './auth.js';
import { db, isMember, type UserRow } from './db.js';
import { env } from './env.js';
import { DownMixer, mulawDecode, mulawEncode } from './legacyAudio.js';
import { media, mediaRoomName } from './media.js';

/**
 * The bridge for the legacy (Windows XP and 7) call client. The old client cannot run WebRTC, so this process does it
 * for it: the client sends 20 ms G.711 mu-law frames over a WebSocket, the bridge joins the call's LiveKit room as an
 * ordinary participant (identity `userId:device`, the same as any other device), publishes that audio as a microphone
 * track, and sends everyone else's mixed audio back down the same socket. Web and Windows 10 clients just see one more
 * person. Protocol: docs/NATIVE-CLIENT-CALLS.md section 5; client: client-win/legacy.
 *
 * Off unless LEGACY_BRIDGE=1. Encrypted rooms are refused (the bridge cannot see inside them).
 */

export const T = { HELLO: 1, AUDIO: 2, VIDEO_UP: 3, TILE_DOWN: 4, STATE: 5, CONTROL: 6 } as const;
const HEADER = 12;
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 320; // 20 ms
const FRAME_MS = 20;
const MAX_TILES = 2; // video tiles sent down at once: decoding and re-encoding other people's video is the costly part
const TILE_W = 320;
const TILE_H = 240;
const TILE_MS = 85; // about 11 pictures a second per tile (6 looked choppy)
const TILE_QUALITY = 50;
const CAM_IDLE_MS = 3000; // no picture from the old PC for this long: the camera is off

export function frame(type: number, seq: number, payload: Buffer): Buffer {
  const b = Buffer.allocUnsafe(HEADER + payload.length);
  b[0] = type;
  b[1] = 0;
  b.writeUInt16BE(0, 2);
  b.writeUInt32BE(seq >>> 0, 4);
  b.writeUInt32BE(Date.now() >>> 0, 8);
  payload.copy(b, HEADER);
  return b;
}

type Lk = typeof import('@livekit/rtc-node');
type Sharp = typeof import('sharp').default;

interface RemoteInfo {
  id: string;
  name: string;
  speaking: boolean;
  mic: boolean;
  cam: boolean;
  screen: boolean;
}

export interface BridgeStats {
  sessions: number;
  audioUp: number;
  audioDown: number;
}

class LegacyCallSession {
  private seq = 0;
  private lk!: Lk;
  private room: InstanceType<Lk['Room']> | null = null;
  private source: InstanceType<Lk['AudioSource']> | null = null;
  private micSid: string | null = null;
  private sharp!: Sharp;
  private camSource: InstanceType<Lk['VideoSource']> | null = null;
  private camSid: string | null = null;
  private camBusy = false;
  private camPublishing = false;
  private camTimer: ReturnType<typeof setTimeout> | null = null;
  private tiles = new Map<string, { cancel: () => void }>();
  private muted = false;
  private mixer = new DownMixer(FRAME_SAMPLES);
  private streams = new Map<string, { cancel: () => void }>();
  private speaking = new Set<string>();
  private mixTimer: ReturnType<typeof setTimeout> | null = null;
  private stateTimer: ReturnType<typeof setInterval> | null = null;
  private stateDirty: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  stats = { audioUp: 0, audioDown: 0, upDropped: 0, videoUp: 0, videoUpDropped: 0, tilesDown: 0, started: Date.now() };

  constructor(
    private readonly ws: WebSocket,
    readonly user: UserRow,
    readonly roomId: string,
    readonly device: string,
    private readonly log: BridgeLog,
    private readonly onEnd: () => void,
    private readonly mediaKey: Buffer | null = null,
  ) {}

  private send(type: number, payload: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame(type, this.seq++, payload));
  }

  private sendJson(type: number, obj: unknown): void {
    this.send(type, Buffer.from(JSON.stringify(obj)));
  }

  /** Joins the LiveKit room and starts the audio loops. Throws with a readable reason when it cannot. */
  async start(): Promise<void> {
    this.lk = await import('@livekit/rtc-node');
    this.sharp = (await import('sharp')).default;
    const lk = this.lk;
    const token = await media.mintToken({
      identity: `${this.user.id}:${this.device}`,
      name: this.user.display_name,
      room: mediaRoomName(this.roomId),
    });
    const room = new lk.Room();
    this.room = room;

    room.on(lk.RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind === lk.TrackKind.KIND_AUDIO) this.listen(track, participant.identity);
      else if (track.kind === lk.TrackKind.KIND_VIDEO) this.startTile(track, this.tileKey(participant.identity, pub.source === lk.TrackSource.SOURCE_SCREENSHARE));
    });
    room.on(lk.RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
      if (track.kind === lk.TrackKind.KIND_AUDIO) this.stopListening(participant.identity);
      else if (track.kind === lk.TrackKind.KIND_VIDEO) this.stopTile(this.tileKey(participant.identity, pub.source === lk.TrackSource.SOURCE_SCREENSHARE));
    });
    room.on(lk.RoomEvent.ParticipantConnected, () => {
      this.rebalance();
      this.markState();
    });
    room.on(lk.RoomEvent.ParticipantDisconnected, (p) => {
      this.stopListening(p.identity);
      this.stopTile(this.tileKey(p.identity, false));
      this.stopTile(this.tileKey(p.identity, true));
      this.speaking.delete(p.identity);
      this.rebalance();
      this.markState();
    });
    room.on(lk.RoomEvent.TrackMuted, () => this.markState());
    room.on(lk.RoomEvent.TrackUnmuted, () => this.markState());
    room.on(lk.RoomEvent.TrackPublished, () => {
      this.rebalance();
      this.markState();
    });
    room.on(lk.RoomEvent.TrackUnpublished, () => {
      this.rebalance();
      this.markState();
    });
    room.on(lk.RoomEvent.ActiveSpeakersChanged, (speakers) => {
      this.speaking = new Set(speakers.map((s) => s.identity));
      this.markState();
    });
    room.on(lk.RoomEvent.Disconnected, () => {
      if (!this.closed) this.end('The call server closed the connection.');
    });

    await room.connect(env.LIVEKIT_INTERNAL_URL.replace(/^http/, 'ws'), token, {
      autoSubscribe: false, // subscribed by hand: all audio, but only a couple of video tracks (see rebalance)
      dynacast: false,
      // An encrypted conversation: the same settings as the web and native clients (shared key, GCM, ratchet window 8, 16 keys).
      // The key is the call's media key as text; it lives in memory for the length of the call and is never logged.
      ...(this.mediaKey
        ? {
            encryption: {
              keyProviderOptions: { sharedKey: this.mediaKey, ratchetSalt: new TextEncoder().encode('LKFrameEncryptionKey'), ratchetWindowSize: 8, failureTolerance: -1, keyRingSize: 16 },
              encryptionType: lk.EncryptionType.GCM,
            },
          }
        : {}),
    });

    this.source = new lk.AudioSource(SAMPLE_RATE, 1);
    await this.publishMic();

    this.rebalance(); // everyone already in the room

    this.startMixer();
    this.stateTimer = setInterval(() => this.sendState(), 2000);
    this.sendState();
  }

  private async publishMic(): Promise<void> {
    const lk = this.lk;
    const track = lk.LocalAudioTrack.createAudioTrack('microphone', this.source!);
    const opts = new lk.TrackPublishOptions();
    opts.source = lk.TrackSource.SOURCE_MICROPHONE;
    const pub = await this.room!.localParticipant!.publishTrack(track, opts);
    this.micSid = pub.sid ?? null;
    this.log.info({ user: this.user.id, sid: this.micSid }, 'legacy call: microphone published');
  }

  /** The SDK has no mute call for a published track, so a muted old PC unpublishes its microphone and unmuting publishes it again. */
  private async setMuted(muted: boolean): Promise<void> {
    this.log.info({ user: this.user.id, muted, sid: this.micSid }, 'legacy call: mute request');
    if (muted === this.muted || this.closed || !this.room?.localParticipant) return;
    this.muted = muted;
    try {
      if (muted) {
        if (this.micSid) await this.room.localParticipant.unpublishTrack(this.micSid);
        this.micSid = null;
      } else if (!this.micSid) {
        await this.publishMic();
      }
    } catch (err) {
      this.log.warn({ user: this.user.id, err: (err as Error).message }, 'legacy call: could not change the microphone');
    }
  }

  private tileKey(identity: string, screen: boolean): string {
    return screen ? `${identity}|screen` : identity;
  }

  /**
   * Which tracks this PC receives: all audio, and at most MAX_TILES video tracks (screen shares first, then cameras in a steady order).
   * Everything else stays unsubscribed, so the SDK does not even download or decode it.
   */
  private rebalance(): void {
    const lk = this.lk;
    const room = this.room;
    if (!room || this.closed) return;
    const video: { pub: { sid?: string; setSubscribed: (s: boolean) => void }; key: string; screen: boolean }[] = [];
    for (const p of room.remoteParticipants.values()) {
      // another device of this same account (the person's own browser tab, say) is never worth a tile: it would only show them themselves
      const mine = p.identity.startsWith(`${this.user.id}:`);
      for (const pub of p.trackPublications.values()) {
        if (pub.kind === lk.TrackKind.KIND_AUDIO) pub.setSubscribed(true);
        else if (pub.kind === lk.TrackKind.KIND_VIDEO) {
          if (mine) {
            pub.setSubscribed(false);
            continue;
          }
          const screen = pub.source === lk.TrackSource.SOURCE_SCREENSHARE;
          video.push({ pub, key: this.tileKey(p.identity, screen), screen });
        }
      }
    }
    video.sort((a, b) => Number(b.screen) - Number(a.screen) || a.key.localeCompare(b.key));
    video.forEach((v, i) => v.pub.setSubscribed(i < MAX_TILES));
  }

  /** Starts sending a remote video track down as small JPEG tiles, at most TILE_MS apart and never more than one in flight. */
  private startTile(track: unknown, key: string): void {
    if (this.tiles.has(key)) return;
    const lk = this.lk;
    const stream = new lk.VideoStream(track as never);
    const reader = stream.getReader();
    let cancelled = false;
    this.tiles.set(key, {
      cancel: () => {
        cancelled = true;
        void reader.cancel().catch(() => {});
      },
    });
    const idBytes = Buffer.from(key, 'utf8');
    void (async () => {
      let last = 0;
      let busy = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || cancelled || this.closed) break;
          const now = Date.now();
          if (busy || now - last < TILE_MS) continue; // dropped before the costly conversion
          busy = true;
          last = now;
          try {
            const rgba = value.frame.convert(lk.VideoBufferType.RGBA);
            const jpeg = await this.sharp(Buffer.from(rgba.data.buffer, rgba.data.byteOffset, rgba.data.length), { raw: { width: rgba.width, height: rgba.height, channels: 4 } })
              .resize({ width: TILE_W, height: TILE_H, fit: 'inside' })
              .jpeg({ quality: TILE_QUALITY })
              .toBuffer();
            if (!cancelled && !this.closed) {
              this.stats.tilesDown++;
              this.send(T.TILE_DOWN, Buffer.concat([Buffer.from([idBytes.length]), idBytes, jpeg]));
            }
          } catch {
            /* a bad frame: skip it */
          }
          busy = false;
        }
      } catch {
        /* the stream ended */
      }
      this.tiles.delete(key);
    })();
  }

  private stopTile(key: string): void {
    this.tiles.get(key)?.cancel();
    this.tiles.delete(key);
  }

  /** One JPEG from the old PC's camera: decoded, handed to the call as a video frame. The first picture publishes the camera track. */
  onVideo(jpeg: Buffer): void {
    if (this.closed || this.camBusy || !this.room?.localParticipant) {
      this.stats.videoUpDropped++;
      return;
    }
    this.camBusy = true;
    void (async () => {
      try {
        const { data, info } = await this.sharp(jpeg).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
        const lk = this.lk;
        if (!this.camSource || this.camSource.width !== info.width || this.camSource.height !== info.height) {
          if (this.camPublishing) return;
          await this.unpublishCamera();
          this.camPublishing = true;
          try {
            this.camSource = new lk.VideoSource(info.width, info.height);
            const track = lk.LocalVideoTrack.createVideoTrack('camera', this.camSource);
            const opts = new lk.TrackPublishOptions();
            opts.source = lk.TrackSource.SOURCE_CAMERA;
            opts.simulcast = false;
            opts.videoCodec = lk.VideoCodec.VP8;
            const pub = await this.room!.localParticipant!.publishTrack(track, opts);
            this.camSid = pub.sid ?? null;
          } finally {
            this.camPublishing = false;
          }
        }
        this.camSource.captureFrame(new lk.VideoFrame(new Uint8Array(data.buffer, data.byteOffset, data.length), info.width, info.height, lk.VideoBufferType.RGBA));
        this.stats.videoUp++;
        if (this.camTimer) clearTimeout(this.camTimer);
        this.camTimer = setTimeout(() => void this.unpublishCamera(), CAM_IDLE_MS); // no pictures for a while: the camera is off
      } catch (err) {
        this.log.warn({ user: this.user.id, err: (err as Error).message }, 'legacy call: a camera picture could not be used');
      } finally {
        this.camBusy = false;
      }
    })();
  }

  private async unpublishCamera(): Promise<void> {
    if (this.camTimer) clearTimeout(this.camTimer);
    this.camTimer = null;
    const sid = this.camSid;
    const source = this.camSource;
    this.camSid = null;
    this.camSource = null;
    try {
      if (sid && this.room?.localParticipant) await this.room.localParticipant.unpublishTrack(sid);
      await source?.close();
    } catch {
      /* already gone */
    }
  }

  /** One frame of the old client's microphone: 320 bytes of mu-law, 16 kHz mono. */
  onAudio(payload: Buffer): void {
    const src = this.source;
    if (!src || this.muted || payload.length !== FRAME_SAMPLES) return;
    if (src.queuedDuration > 400) {
      this.stats.upDropped++; // the call engine is not draining: drop instead of building up delay
      return;
    }
    const pcm = mulawDecode(payload);
    this.stats.audioUp++;
    void src.captureFrame(new this.lk.AudioFrame(pcm, SAMPLE_RATE, 1, FRAME_SAMPLES)).catch(() => {});
  }

  control(cmd: { cmd?: string; muted?: boolean; on?: boolean }): void {
    if (cmd.cmd === 'leave') this.end('');
    else if (cmd.cmd === 'mute') void this.setMuted(Boolean(cmd.muted));
    else if (cmd.cmd === 'camera' && cmd.on === false) void this.unpublishCamera();
    else if (cmd.cmd === 'stats') this.sendJson(T.STATE, { stats: this.stats, sources: this.mixer.sources });
  }

  private listen(track: unknown, identity: string): void {
    if (this.streams.has(identity)) return;
    const lk = this.lk;
    const stream = new lk.AudioStream(track as never, { sampleRate: SAMPLE_RATE, numChannels: 1, frameSizeMs: FRAME_MS });
    this.streams.set(identity, { cancel: () => void stream.cancel().catch(() => {}) });
    void (async () => {
      try {
        for await (const f of stream as unknown as AsyncIterable<{ data: Int16Array }>) {
          if (this.closed) break;
          this.mixer.push(identity, f.data);
        }
      } catch {
        /* the stream ended */
      }
      this.mixer.remove(identity);
    })();
  }

  private stopListening(identity: string): void {
    this.streams.get(identity)?.cancel();
    this.streams.delete(identity);
    this.mixer.remove(identity);
  }

  /** A drift-corrected 20 ms clock: a late tick is followed by a short one, so the long-run rate is exact. */
  private startMixer(): void {
    let next = Date.now() + FRAME_MS;
    const tick = () => {
      if (this.closed) return;
      const out = this.mixer.next();
      if (out) {
        this.stats.audioDown++;
        this.send(T.AUDIO, mulawEncode(out));
      }
      next += FRAME_MS;
      const wait = next - Date.now();
      if (wait < -200) next = Date.now() + FRAME_MS; // far behind (a stall): do not burst to catch up
      this.mixTimer = setTimeout(tick, Math.max(1, next - Date.now()));
    };
    this.mixTimer = setTimeout(tick, FRAME_MS);
  }

  private markState(): void {
    if (this.stateDirty || this.closed) return;
    this.stateDirty = setTimeout(() => {
      this.stateDirty = null;
      this.sendState();
    }, 150);
  }

  private people(): RemoteInfo[] {
    const lk = this.lk;
    const out: RemoteInfo[] = [];
    for (const p of this.room?.remoteParticipants.values() ?? []) {
      let mic = false;
      let cam = false;
      let screen = false;
      for (const pub of p.trackPublications.values()) {
        if (pub.kind === lk.TrackKind.KIND_AUDIO && !pub.muted) mic = true;
        if (pub.kind === lk.TrackKind.KIND_VIDEO) {
          if (pub.source === lk.TrackSource.SOURCE_SCREENSHARE) screen = true;
          else cam = true;
        }
      }
      out.push({ id: p.identity, name: p.name || p.identity, speaking: this.speaking.has(p.identity), mic, cam, screen });
    }
    return out;
  }

  private sendState(): void {
    if (this.closed) return;
    this.sendJson(T.STATE, { participants: this.people() });
  }

  /** Ends the session: tells the client why (when there is a reason), leaves the room, frees everything. */
  end(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.mixTimer) clearTimeout(this.mixTimer);
    if (this.stateTimer) clearInterval(this.stateTimer);
    if (this.stateDirty) clearTimeout(this.stateDirty);
    for (const s of this.streams.values()) s.cancel();
    this.streams.clear();
    for (const t of this.tiles.values()) t.cancel();
    this.tiles.clear();
    if (this.camTimer) clearTimeout(this.camTimer);
    if (reason && this.ws.readyState === WebSocket.OPEN) this.sendJson(T.STATE, { ended: reason });
    const room = this.room;
    this.room = null;
    void (async () => {
      try {
        await room?.disconnect();
      } catch {
        /* already gone */
      }
      this.log.info({ user: this.user.id, room: this.roomId, ...this.stats }, 'legacy call ended');
    })();
    try {
      this.ws.close(1000, reason.slice(0, 100));
    } catch {
      /* already closed */
    }
    this.onEnd();
  }
}

export interface BridgeLog {
  info: (o: unknown, msg?: string) => void;
  warn: (o: unknown, msg?: string) => void;
}

let roomEncrypted: ReturnType<typeof db.prepare> | undefined;

/**
 * What the bridge tells the hub about a legacy client's seat. Narrow on purpose: the bridge is a
 * LiveKit participant, so the hub's call record has to hear about it or the call looks empty.
 */
export interface LegacyCallSeats {
  legacyJoin(roomId: string, userId: string, device: string): void;
  legacyLeave(roomId: string, userId: string, device: string): void;
}

export class LegacyBridge {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  private sessions = new Set<LegacyCallSession>();

  constructor(
    private readonly log: BridgeLog,
    private readonly maxSessions = Number(process.env.LEGACY_BRIDGE_MAX ?? 8),
    private readonly seats: LegacyCallSeats | null = null,
  ) {}

  stats(): BridgeStats {
    let audioUp = 0;
    let audioDown = 0;
    for (const s of this.sessions) {
      audioUp += s.stats.audioUp;
      audioDown += s.stats.audioDown;
    }
    return { sessions: this.sessions.size, audioUp, audioDown };
  }

  attach(app: FastifyInstance): void {
    app.server.on('upgrade', (req, socket, head) => {
      if (!req.url || !req.url.startsWith('/legacycall')) return; // not ours: the realtime hub handles /ws
      const user = userFromToken(tokenFromCookieHeader(req.headers.cookie));
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, user));
    });
  }

  private onConnection(ws: WebSocket, user: UserRow): void {
    let session: LegacyCallSession | null = null;
    let joining = false;
    const hello = setTimeout(() => ws.close(1008, 'no HELLO'), 10000);
    const refuse = (error: string) => {
      ws.send(frame(T.HELLO, 0, Buffer.from(JSON.stringify({ ok: false, error }))));
      ws.close(1000, error.slice(0, 100));
    };

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const f = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
      if (f.length < HEADER) return;
      const type = f[0]!;
      const payload = f.subarray(HEADER);

      if (type === T.HELLO && !session && !joining) {
        joining = true;
        clearTimeout(hello);
        let h: { room?: string; device?: string; mediaKey?: string };
        try {
          h = JSON.parse(payload.toString('utf8'));
        } catch {
          return refuse('bad HELLO');
        }
        const roomId = typeof h.room === 'string' ? h.room : '';
        const device = typeof h.device === 'string' && /^[\w.-]{1,64}$/.test(h.device) ? h.device : 'legacy';
        if (!roomId || !isMember(roomId, user.id)) return refuse('not a member of this conversation');
        const enc = (roomEncrypted ??= db.prepare('SELECT encrypted FROM rooms WHERE id = ?')).get(roomId) as { encrypted: number } | undefined;
        if (!enc) return refuse('unknown conversation');
        let mediaKey: Buffer | null = null;
        if (enc.encrypted) {
          // Joining an encrypted conversation means this server holds its call key for the length of the call (it can then hear the call).
          // The client asks the person first and sends the key here; without it (or with this switched off) the conversation is refused.
          if (process.env.LEGACY_BRIDGE_E2EE === '0') return refuse('This conversation is end-to-end encrypted. This server does not allow old-Windows calls into encrypted conversations; use a browser or Windows 10 or later.');
          if (typeof h.mediaKey !== 'string' || h.mediaKey.length < 16 || h.mediaKey.length > 256) {
            ws.send(frame(T.HELLO, 0, Buffer.from(JSON.stringify({ ok: false, need: 'mediaKey', error: 'This conversation is end-to-end encrypted. To join from this PC the call key has to be given to the server for the length of the call.' }))));
            ws.close(1000, 'media key needed');
            return;
          }
          mediaKey = Buffer.from(h.mediaKey, 'ascii');
        }
        if (this.sessions.size >= this.maxSessions) return refuse('The call bridge is full right now. Try again in a moment.');
        for (const s of this.sessions) if (s.user.id === user.id && s.device === device) s.end('Replaced by a newer connection.');

        const s = new LegacyCallSession(ws, user, roomId, device, this.log, () => {
          this.seats?.legacyLeave(roomId, user.id, device);
          this.sessions.delete(s);
        }, mediaKey);
        this.sessions.add(s);
        session = s;
        s.start().then(
          () => {
            this.seats?.legacyJoin(roomId, user.id, device);
            ws.send(frame(T.HELLO, 0, Buffer.from(JSON.stringify({ ok: true, bridge: 'hearth', codecs: ['pcm-mulaw16'], room: roomId, identity: `${user.id}:${device}` }))));
            this.log.info({ user: user.id, room: roomId, device }, 'legacy call started');
          },
          (err: Error) => {
            this.log.warn({ user: user.id, room: roomId, err: err.message }, 'legacy call could not join');
            s.end('');
            this.sessions.delete(s);
            refuse(`Could not join the call: ${err.message}`);
          },
        );
      } else if (session) {
        if (type === T.AUDIO) session.onAudio(Buffer.from(payload));
        else if (type === T.VIDEO_UP) session.onVideo(Buffer.from(payload));
        else if (type === T.CONTROL) {
          try {
            session.control(JSON.parse(payload.toString('utf8')));
          } catch {
            /* ignore a malformed control frame */
          }
        }
      }
    });
    ws.on('close', () => {
      clearTimeout(hello);
      session?.end('');
    });
    ws.on('error', () => session?.end(''));
  }
}

export function attachLegacyBridge(app: FastifyInstance, seats: LegacyCallSeats | null = null): LegacyBridge | null {
  if (process.env.LEGACY_BRIDGE !== '1') return null;
  const bridge = new LegacyBridge(
    { info: (o, m) => app.log.info(o as object, m), warn: (o, m) => app.log.warn(o as object, m) },
    undefined,
    seats,
  );
  bridge.attach(app);
  app.log.info('legacy call bridge is on (/legacycall)');
  return bridge;
}
