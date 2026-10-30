/**
 * Camera and microphone health for people in a call, and the server-side
 * cross-check against what the media engine (LiveKit) really sees.
 *
 * Everything here is pure: the clock and the media probe are injected, so the
 * rules (debounce, cooldown, ghost seats, watchdog) are testable without
 * timers, sockets or a running LiveKit.
 */
import type { MediaState } from './callState.js';

/** One health vocabulary for mic and cam. `silent` is mic-only, `no-frames` cam-only. */
export const HEALTH_VALUES = [
  'off',
  'on',
  'silent',
  'no-frames',
  'interrupted',
  'restarting',
  'failed',
] as const;
export type Health = (typeof HEALTH_VALUES)[number];

export interface MediaHealth {
  mic: Health;
  cam: Health;
}

export function isHealth(v: unknown): v is Health {
  return typeof v === 'string' && (HEALTH_VALUES as readonly string[]).includes(v);
}

/** Parse the optional `health` of a call.state frame; anything malformed is dropped. */
export function parseHealth(raw: unknown): MediaHealth | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (!isHealth(r.mic) && !isHealth(r.cam)) return undefined;
  return { mic: isHealth(r.mic) ? r.mic : 'off', cam: isHealth(r.cam) ? r.cam : 'off' };
}

/**
 * Make the health of a device agree with its signalled flags. A flag that is
 * off can only be `off`, `restarting`, `interrupted` or `failed`; a flag that
 * is on can not be `off`. A client that reports no health gets plain on/off.
 */
export function normalizeHealth(
  flags: { mic: boolean; cam: boolean },
  health: MediaHealth | undefined,
): MediaHealth {
  const one = (on: boolean, h: Health | undefined): Health => {
    if (h === undefined) return on ? 'on' : 'off';
    if (on) return h === 'off' ? 'on' : h;
    return h === 'restarting' || h === 'failed' || h === 'interrupted' ? h : 'off';
  };
  return { mic: one(flags.mic, health?.mic), cam: one(flags.cam, health?.cam) };
}

/** What LiveKit says one participant is really publishing. */
export interface LkParticipant {
  identity: string;
  /** Live (published and not muted) tracks per source. */
  mic: boolean;
  cam: boolean;
  screen: boolean;
  /** Published at all, muted or not (for the reason shown). */
  published: { mic: boolean; cam: boolean; screen: boolean };
}

/** The seam to the media engine. `null` means it could not be reached. */
export interface LiveKitProbe {
  inspectRoom(room: string): Promise<LkParticipant[] | null>;
}

export interface HealthConfig {
  /** A mismatch must persist this long (and over >= 2 probes) before it is corrected. */
  mismatchMs: number;
  /** Minimum gap between corrections of the same identity+kind; doubles per repeat. */
  cooldownMs: number;
  /** Forget the repeat count after this long without a correction. */
  backoffResetMs: number;
  /** In the call list but absent from the media engine this long: a ghost seat. */
  ghostMs: number;
  /** No socket and no report for this long: release the seat. */
  watchdogMs: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  mismatchMs: 12_000,
  cooldownMs: 30_000,
  backoffResetMs: 10 * 60_000,
  ghostMs: 45_000,
  watchdogMs: 90_000,
};

export interface SeatInput {
  userId: string;
  device: string;
  identity: string;
  state?: MediaState;
  joinedAt: number;
  hasSocket: boolean;
}

export type Kind = 'mic' | 'cam' | 'screen';

export interface Correction {
  identity: string;
  userId: string;
  device: string;
  kind: Kind;
  /** What the server now says is true. */
  value: boolean;
  reason: string;
}

export interface SeatRelease {
  userId: string;
  device: string;
  identity: string;
  reason: 'ghost' | 'watchdog';
}

export interface Decision {
  corrections: Correction[];
  releases: SeatRelease[];
  /** False when the media engine was unreachable, so nothing was judged. */
  checked: boolean;
}

interface Tracker {
  missingSince?: number;
  mismatch: Partial<Record<Kind, { since: number; claimed: boolean; probes: number }>>;
  lastCorrected: Partial<Record<Kind, number>>;
  repeats: Partial<Record<Kind, number>>;
}

const KINDS: Kind[] = ['mic', 'cam', 'screen'];

export class CallHealthMonitor {
  private trackers = new Map<string, Tracker>();

  constructor(
    private now: () => number = Date.now,
    private cfg: HealthConfig = DEFAULT_HEALTH_CONFIG,
  ) {}

  private tracker(roomId: string, identity: string): Tracker {
    const key = `${roomId}|${identity}`;
    let t = this.trackers.get(key);
    if (!t) {
      t = { mismatch: {}, lastCorrected: {}, repeats: {} };
      this.trackers.set(key, t);
    }
    return t;
  }

  /** The call ended: drop what we remember about it. */
  forgetRoom(roomId: string): void {
    for (const k of [...this.trackers.keys()]) if (k.startsWith(`${roomId}|`)) this.trackers.delete(k);
  }

  /** A seat went away: drop what we remember about it. */
  forgetSeat(roomId: string, identity: string): void {
    this.trackers.delete(`${roomId}|${identity}`);
  }

  /**
   * Judge one call. `lk` is what the media engine reports now, or null when it
   * could not be asked: then nothing about it is judged and the absence timers
   * restart, so an outage never turns into a pile of ghost seats afterwards.
   */
  evaluate(roomId: string, seats: SeatInput[], lk: LkParticipant[] | null): Decision {
    const now = this.now();
    const out: Decision = { corrections: [], releases: [], checked: lk !== null };

    // Watchdog first: independent of the media engine being reachable.
    const released = new Set<string>();
    for (const s of seats) {
      const lastActivity = Math.max(s.joinedAt, s.state?.reportAt ?? 0);
      if (!s.hasSocket && now - lastActivity >= this.cfg.watchdogMs) {
        out.releases.push({ userId: s.userId, device: s.device, identity: s.identity, reason: 'watchdog' });
        released.add(s.identity);
      }
    }

    if (lk === null) {
      for (const s of seats) {
        const t = this.trackers.get(`${roomId}|${s.identity}`);
        if (t) {
          t.missingSince = undefined;
          t.mismatch = {};
        }
      }
      return out;
    }

    const byIdentity = new Map(lk.map((p) => [p.identity, p]));
    for (const s of seats) {
      if (released.has(s.identity)) continue;
      const t = this.tracker(roomId, s.identity);
      const p = byIdentity.get(s.identity);

      if (!p) {
        t.mismatch = {};
        t.missingSince ??= now;
        const since = Math.max(t.missingSince, s.joinedAt);
        if (now - since >= this.cfg.ghostMs) {
          out.releases.push({ userId: s.userId, device: s.device, identity: s.identity, reason: 'ghost' });
        }
        continue;
      }
      t.missingSince = undefined;
      if (!s.state) continue; // nothing signalled yet: nothing to contradict

      for (const kind of KINDS) {
        const claimed = Boolean(s.state[kind]);
        const live = p[kind];
        if (claimed === live) {
          delete t.mismatch[kind];
          continue;
        }
        const cur = t.mismatch[kind];
        if (!cur || cur.claimed !== claimed) {
          // New disagreement, or the client changed its claim: start over.
          t.mismatch[kind] = { since: now, claimed, probes: 1 };
          continue;
        }
        cur.probes += 1;
        if (cur.probes < 2 || now - cur.since < this.cfg.mismatchMs) continue;

        const last = t.lastCorrected[kind];
        if (last !== undefined && now - last >= this.cfg.backoffResetMs) t.repeats[kind] = 0;
        const repeats = t.repeats[kind] ?? 0;
        const wait = this.cfg.cooldownMs * 2 ** Math.min(repeats, 4);
        if (last !== undefined && now - last < wait) continue;

        t.lastCorrected[kind] = now;
        t.repeats[kind] = repeats + 1;
        delete t.mismatch[kind];
        out.corrections.push({
          identity: s.identity,
          userId: s.userId,
          device: s.device,
          kind,
          value: live,
          reason: claimed
            ? p.published[kind]
              ? `signalled ${kind} on but the track is muted`
              : `signalled ${kind} on but nothing is published`
            : `signalled ${kind} off but a live track is publishing`,
        });
      }
    }
    return out;
  }
}
