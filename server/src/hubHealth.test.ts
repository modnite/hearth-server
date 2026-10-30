import { describe, it, expect, vi, beforeEach } from 'vitest';

// The Hub talks to sqlite, auth, push and LiveKit; stub those so the call
// bookkeeping and the health cross-check run on their own.
vi.mock('./db.js', () => ({
  db: {
    prepare: () => ({ get: () => ({ id: 'x', status: 'online', status_preset: 'online' }), run: () => {}, all: () => [] }),
    transaction: (fn: () => unknown) => fn,
  },
  now: () => Date.now(),
  isMember: () => true,
  memberIds: () => ['u1', 'u2'],
  publicUser: (u: unknown) => u,
}));
vi.mock('./auth.js', () => ({ tokenFromCookieHeader: () => null, userFromToken: () => null }));
vi.mock('./push.js', () => ({ pushToUser: () => {} }));
vi.mock('./media.js', () => ({
  media: { listRooms: async () => [], listParticipants: async () => [] },
  mediaProbe: { inspectRoom: async () => null },
  mediaRoomName: (r: string) => `hearth_${r}`,
  roomIdFromMediaName: (n: string) => n.replace(/^hearth_/, ''),
}));

import { Hub } from './realtime.js';
import { CallHealthMonitor, type LkParticipant, type LiveKitProbe } from './callHealth.js';

class FakeWs {
  readyState = 1;
  sent: any[] = [];
  handlers: Record<string, (...a: any[]) => void> = {};
  on(ev: string, fn: (...a: any[]) => void) {
    this.handlers[ev] = fn;
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  ping() {}
  say(frame: unknown) {
    this.handlers.message!(Buffer.from(JSON.stringify(frame)));
  }
  close() {
    this.handlers.close!();
  }
  calls() {
    return this.sent.filter((f) => f.t === 'call.active');
  }
}

const lk = (identity: string, live: Partial<Record<'mic' | 'cam' | 'screen', boolean>> = {}): LkParticipant => ({
  identity,
  mic: !!live.mic,
  cam: !!live.cam,
  screen: !!live.screen,
  published: { mic: !!live.mic, cam: !!live.cam, screen: !!live.screen },
});

let clock = 5_000_000;
let engine: LkParticipant[] | null = [];
let probes = 0;
const probe: LiveKitProbe = {
  inspectRoom: async () => {
    probes += 1;
    return engine;
  },
};

function mk() {
  const hub = new Hub();
  hub.configureHealth(probe, new CallHealthMonitor(() => clock));
  const connect = (id: string, device: string) => {
    const ws = new FakeWs();
    (hub as any).onConnection(ws, { id, display_name: id }, device);
    return ws;
  };
  return { hub, connect };
}

beforeEach(() => {
  clock = 5_000_000;
  engine = [];
  probes = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

const lastState = (ws: FakeWs, id: string) => ws.calls().at(-1)?.states?.[id];

describe('call.state health field', () => {
  it('stores and relays health + reportAt, and derives plain health for old clients', () => {
    const { connect } = mk();
    const a = connect('u1', 'web');
    const b = connect('u2', 'web');
    a.say({ t: 'call.join', roomId: 'r' });
    a.say({ t: 'call.state', roomId: 'r', mic: true, cam: true, screen: false, health: { mic: 'on', cam: 'no-frames' } });
    expect(lastState(b, 'u1:web')).toMatchObject({ mic: true, cam: true, health: { mic: 'on', cam: 'no-frames' }, reportAt: clock });
    // An old client sends no health.
    b.say({ t: 'call.join', roomId: 'r' });
    b.say({ t: 'call.state', roomId: 'r', mic: false, cam: false, screen: false });
    expect(lastState(a, 'u2:web').health).toEqual({ mic: 'off', cam: 'off' });
  });

  it('rejects garbage health values', () => {
    const { connect } = mk();
    const a = connect('u1', 'web');
    a.say({ t: 'call.join', roomId: 'r' });
    a.say({ t: 'call.state', roomId: 'r', mic: true, cam: false, screen: false, health: { mic: '<script>', cam: 3 } });
    expect(lastState(a, 'u1:web').health).toEqual({ mic: 'on', cam: 'off' });
  });
});

describe('health cross-check', () => {
  it('does not overwrite a resumed mic report with a probe started before the report arrived', async () => {
    const { hub, connect } = mk();
    const a = connect('u1', 'web');
    const b = connect('u2', 'web');
    a.say({ t: 'call.join', roomId: 'r' });
    a.say({ t: 'call.state', roomId: 'r', mic: true, cam: false, screen: false });
    engine = [lk('u1:web')];
    await hub.runHealthCheck();
    clock += 15_000;
    let finish!: (v: LkParticipant[]) => void;
    hub.configureHealth({ inspectRoom: () => new Promise((r) => { finish = r; }) });
    const pending = hub.runHealthCheck();
    a.say({ t: 'call.state', roomId: 'r', mic: true, cam: false, screen: false, health: { mic: 'on', cam: 'off' } });
    finish([lk('u1:web')]);
    await pending;
    expect(lastState(b, 'u1:web')).toMatchObject({ mic: true, health: { mic: 'on' } });
    expect(lastState(b, 'u1:web').corrected).toBeUndefined();
  });

  it('replaces a paused report with the recovered report for every peer', () => {
    const { connect } = mk();
    const a = connect('u1', 'web'); const b = connect('u2', 'web');
    a.say({ t: 'call.join', roomId: 'r' });
    a.say({ t: 'call.state', roomId: 'r', mic: true, cam: false, screen: false, health: { mic: 'interrupted', cam: 'off' } });
    expect(lastState(b, 'u1:web').health.mic).toBe('interrupted');
    a.say({ t: 'call.state', roomId: 'r', mic: true, cam: false, screen: false, health: { mic: 'on', cam: 'off' } });
    expect(lastState(b, 'u1:web').health.mic).toBe('on');
  });

  it('ordinary Leave keeps a call with a media participant missing from the hub roster', async () => {
    vi.useFakeTimers();
    try {
      const { hub, connect } = mk();
      const a = connect('u1', 'web');
      a.say({ t: 'call.join', roomId: 'r' });
      engine = [lk('u2:phone', { mic: true })];
      a.say({ t: 'call.leave', roomId: 'r' });
      await vi.advanceTimersByTimeAsync(1);
      expect((hub as any).calls.has('r')).toBe(true);
      engine = [];
      await vi.advanceTimersByTimeAsync(20_000);
      expect((hub as any).calls.has('r')).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('corrects cam signalled on when LiveKit has no live video, and broadcasts it once', async () => {
    const { hub, connect } = mk();
    const a = connect('u1', 'web');
    const b = connect('u2', 'web');
    a.say({ t: 'call.join', roomId: 'r' });
    a.say({ t: 'call.state', roomId: 'r', mic: true, cam: true, screen: false });
    engine = [lk('u1:web', { mic: true })];
    await hub.runHealthCheck(); // first sight
    expect(lastState(b, 'u1:web').cam).toBe(true);
    clock += 15_000;
    const before = b.calls().length;
    await hub.runHealthCheck();
    const st = lastState(b, 'u1:web');
    expect(st.cam).toBe(false);
    expect(st.health.cam).toBe('interrupted');
    expect(st.corrected.by).toBe('livekit');
    expect(b.calls().length).toBe(before + 1);
    // No flapping: more probes with the same engine state broadcast nothing.
    for (let i = 0; i < 5; i++) {
      clock += 10_000;
      await hub.runHealthCheck();
    }
    expect(b.calls().length).toBe(before + 1);
  });

  it('corrects mic signalled off but publishing', async () => {
    const { hub, connect } = mk();
    const a = connect('u1', 'web');
    a.say({ t: 'call.join', roomId: 'r' });
    a.say({ t: 'call.state', roomId: 'r', mic: false, cam: false, screen: false });
    engine = [lk('u1:web', { mic: true })];
    await hub.runHealthCheck();
    clock += 15_000;
    await hub.runHealthCheck();
    expect(lastState(a, 'u1:web')).toMatchObject({ mic: true, health: { mic: 'on' } });
  });

  it('removes a ghost seat but keeps the call alive for the other device', async () => {
    const { hub, connect } = mk();
    const a = connect('u1', 'web');
    const p = connect('u1', 'phone');
    a.say({ t: 'call.join', roomId: 'r' });
    p.say({ t: 'call.join', roomId: 'r' });
    engine = [lk('u1:web', { mic: true })];
    await hub.runHealthCheck();
    clock += 50_000;
    await hub.runHealthCheck();
    const f = a.calls().at(-1);
    expect(f.participants).toEqual(['u1']); // still in via web
    expect(Object.keys(f.states)).not.toContain('u1:phone');
  });

  it('a ghost-emptied call ends for everyone: a call with nobody in it does not stay open', async () => {
    const { hub, connect } = mk();
    const a = connect('u1', 'web');
    a.say({ t: 'call.join', roomId: 'r' });
    engine = [];
    await hub.runHealthCheck();
    clock += 50_000;
    await hub.runHealthCheck();
    expect(a.sent.some((x) => x.t === 'call.end')).toBe(true);
  });

  it('the last person leaving ends the call for everyone after confirming the media room is empty', async () => {
    const { connect } = mk();
    const a = connect('u1', 'web');
    const p = connect('u2', 'web');
    a.say({ t: 'call.join', roomId: 'r' });
    p.say({ t: 'call.join', roomId: 'r' });
    a.say({ t: 'call.leave', roomId: 'r' });
    expect(p.sent.some((x) => x.t === 'call.end')).toBe(false); // one person still in it
    p.say({ t: 'call.leave', roomId: 'r' });
    await Promise.resolve();
    await Promise.resolve();
    expect(a.sent.some((x) => x.t === 'call.end')).toBe(true);
    expect(p.sent.some((x) => x.t === 'call.end')).toBe(true);
  });

  it('a legacy client through the bridge counts as someone still in the call', () => {
    const { hub, connect } = mk();
    const a = connect('u1', 'web');
    a.say({ t: 'call.join', roomId: 'r' });
    // The XP client joins through the bridge: a LiveKit participant with no websocket of its own.
    hub.legacyJoin('r', 'u3', 'legacy');
    expect((hub as any).calls.get('r').participants.has('u3')).toBe(true);
    a.say({ t: 'call.leave', roomId: 'r' });
    expect(a.sent.some((x) => x.t === 'call.end')).toBe(false);
    expect((hub as any).calls.get('r').participants.has('u3')).toBe(true);
  });

  it('the bridge dropping gets the reload grace, then ends the call if nobody is left', async () => {
    vi.useFakeTimers();
    try {
      const { hub, connect } = mk();
      const a = connect('u1', 'web');
      a.say({ t: 'call.join', roomId: 'r' });
      hub.legacyJoin('r', 'u3', 'legacy');
      a.say({ t: 'call.leave', roomId: 'r' });
      hub.legacyLeave('r', 'u3', 'legacy');
      await vi.advanceTimersByTimeAsync(19_000);
      expect(a.sent.some((x) => x.t === 'call.end')).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(a.sent.some((x) => x.t === 'call.end')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing when LiveKit is unreachable, however long', async () => {
    const { hub, connect } = mk();
    const a = connect('u1', 'web');
    a.say({ t: 'call.join', roomId: 'r' });
    a.say({ t: 'call.state', roomId: 'r', mic: true, cam: true, screen: false });
    engine = null;
    const n = a.sent.length;
    for (let i = 0; i < 20; i++) {
      clock += 10_000;
      await hub.runHealthCheck();
    }
    expect(a.sent.length).toBe(n);
    expect(lastState(a, 'u1:web').cam).toBe(true);
  });

  it('skips health checks of an empty roster after the leave path checked media occupancy', async () => {
    const { hub, connect } = mk();
    const a = connect('u1', 'web');
    a.say({ t: 'call.start', roomId: 'r' });
    a.say({ t: 'call.leave', roomId: 'r' });
    expect(probes).toBe(1); // Leave must confirm that media is also empty.
    await hub.runHealthCheck();
    expect(probes).toBe(1); // Health checking adds no second probe.
  });

  it('survives a probe that throws', async () => {
    const { hub, connect } = mk();
    hub.configureHealth({ inspectRoom: async () => { throw new Error('boom'); } }, new CallHealthMonitor(() => clock));
    const a = connect('u1', 'web');
    a.say({ t: 'call.join', roomId: 'r' });
    await expect(hub.runHealthCheck()).resolves.toBeUndefined();
  });
});

describe('watchdog', () => {
  it('a restored seat with no socket and no reports is released', async () => {
    const { hub, connect } = mk();
    const a = connect('u1', 'web');
    a.say({ t: 'call.join', roomId: 'r' });
    // Seat of a device that never connected a socket (as after a server restart).
    const call = (hub as any).calls.get('r');
    call.participants.add('u9');
    call.devices.set('u9', new Set(['web']));
    call.joinedAt.set('u9:web', clock);
    engine = [lk('u1:web', { mic: true }), lk('u9:web', { mic: true })];
    clock += 100_000;
    await hub.runHealthCheck();
    expect(a.calls().at(-1).participants).toEqual(['u1']);
  });
});

describe('a call stays up while the media room still has people in it', () => {
  it('a legacy seat held by the bridge is not released by the watchdog while LiveKit has it', async () => {
    const { hub, connect } = mk();
    const a = connect('u1', 'web');
    a.say({ t: 'call.join', roomId: 'r' });
    hub.legacyJoin('r', 'u3', 'legacy');
    engine = [lk('u1:web'), lk('u3:legacy')];
    for (let i = 0; i < 4; i++) {
      clock += 40_000;
      await hub.runHealthCheck();
    }
    expect(a.sent.some((x) => x.t === 'call.end')).toBe(false);
    expect((hub as any).calls.get('r').participants.has('u3')).toBe(true);
  });

  it('a dropped socket does not end a call LiveKit still has people in, and ends once it is empty', async () => {
    vi.useFakeTimers();
    try {
      const { hub, connect } = mk();
      const a = connect('u1', 'web');
      a.say({ t: 'call.join', roomId: 'r' });
      engine = [lk('u1:web')];
      a.close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect((hub as any).calls.has('r')).toBe(true);
      engine = [];
      await vi.advanceTimersByTimeAsync(45_000);
      expect((hub as any).calls.has('r')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the starter's own join does not stop the ring for the people being rung", () => {
    vi.useFakeTimers();
    try {
      const { hub, connect } = mk();
      const a = connect('u1', 'web');
      const b = connect('u2', 'web');
      a.say({ t: 'call.start', roomId: 'r' });
      a.say({ t: 'call.join', roomId: 'r' });
      expect((hub as any).calls.get('r').ringing).toBe(true);
      expect(b.sent.some((x) => x.t === 'call.ring.stop')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('someone else joining answers the ring', () => {
    vi.useFakeTimers();
    try {
      const { connect } = mk();
      const a = connect('u1', 'web');
      const b = connect('u2', 'web');
      a.say({ t: 'call.start', roomId: 'r' });
      b.say({ t: 'call.join', roomId: 'r' });
      expect(a.sent.some((x) => x.t === 'call.ring.stop')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('an emptied call by a dropped connection', () => {
  it('waits a short grace for a reload, then ends for everyone', async () => {
    vi.useFakeTimers();
    try {
      const { connect } = mk();
      const a = connect('u1', 'web');
      const b = connect('u2', 'web');
      a.say({ t: 'call.join', roomId: 'r' });
      a.close();
      await vi.advanceTimersByTimeAsync(19_000);
      expect(b.sent.some((x) => x.t === 'call.end')).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(b.sent.some((x) => x.t === 'call.end')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the call when the same person is back inside the grace', () => {
    vi.useFakeTimers();
    try {
      const { connect } = mk();
      const a = connect('u1', 'web');
      const b = connect('u2', 'web');
      a.say({ t: 'call.join', roomId: 'r' });
      a.close();
      vi.advanceTimersByTime(8_000);
      const a2 = connect('u1', 'web');
      a2.say({ t: 'call.join', roomId: 'r' });
      vi.advanceTimersByTime(60_000);
      expect(b.sent.some((x) => x.t === 'call.end')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
