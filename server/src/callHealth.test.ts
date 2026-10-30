import { describe, it, expect } from 'vitest';
import {
  CallHealthMonitor,
  DEFAULT_HEALTH_CONFIG,
  normalizeHealth,
  parseHealth,
  type LkParticipant,
  type SeatInput,
} from './callHealth.js';

const lkp = (identity: string, live: Partial<Record<'mic' | 'cam' | 'screen', boolean>> = {}): LkParticipant => ({
  identity,
  mic: !!live.mic,
  cam: !!live.cam,
  screen: !!live.screen,
  published: { mic: !!live.mic, cam: !!live.cam, screen: !!live.screen },
});

type SeatOver = Partial<SeatInput> & { mic?: boolean; cam?: boolean; screen?: boolean };
const seat = (over: SeatOver = {}): SeatInput => {
  const { mic, cam, screen, ...rest } = over;
  return {
    userId: 'u1',
    device: 'web',
    identity: 'u1:web',
    joinedAt: 0,
    hasSocket: true,
    state: { mic: mic ?? true, cam: cam ?? false, screen: screen ?? false, reportAt: 0 },
    ...rest,
  };
};

function setup() {
  let t = 1_000_000;
  const m = new CallHealthMonitor(() => t);
  return { m, tick: (ms: number) => (t += ms), now: () => t };
}

describe('mismatch correction', () => {
  it('corrects cam signalled on with nothing published, after it persists', () => {
    const { m, tick } = setup();
    const s = [seat({ cam: true })];
    const lk = [lkp('u1:web', { mic: true })];
    expect(m.evaluate('r', s, lk).corrections).toEqual([]); // first sight
    tick(10_000);
    expect(m.evaluate('r', s, lk).corrections).toEqual([]); // 10s < 12s
    tick(5_000);
    const d = m.evaluate('r', s, lk);
    expect(d.corrections).toHaveLength(1);
    expect(d.corrections[0]).toMatchObject({ identity: 'u1:web', kind: 'cam', value: false });
    expect(d.corrections[0]!.reason).toMatch(/nothing is published/);
  });

  it('says muted when the track exists but is muted', () => {
    const { m, tick } = setup();
    const s = [seat({ cam: true })];
    const lk: LkParticipant[] = [
      { ...lkp('u1:web', { mic: true }), published: { mic: true, cam: true, screen: false } },
    ];
    m.evaluate('r', s, lk);
    tick(15_000);
    expect(m.evaluate('r', s, lk).corrections[0]!.reason).toMatch(/muted/);
  });

  it('corrects off signalled but a live track is publishing', () => {
    const { m, tick } = setup();
    const s = [seat({ mic: false })];
    const lk = [lkp('u1:web', { mic: true })];
    m.evaluate('r', s, lk);
    tick(15_000);
    expect(m.evaluate('r', s, lk).corrections[0]).toMatchObject({ kind: 'mic', value: true });
  });

  it('does nothing when signalled and real state agree', () => {
    const { m, tick } = setup();
    const s = [seat({ mic: true, cam: true, screen: true })];
    const lk = [lkp('u1:web', { mic: true, cam: true, screen: true })];
    for (let i = 0; i < 10; i++) {
      tick(10_000);
      expect(m.evaluate('r', s, lk).corrections).toEqual([]);
    }
  });

  it('a transient mismatch that resolves is never corrected', () => {
    const { m, tick } = setup();
    const s = [seat({ cam: true })];
    m.evaluate('r', s, [lkp('u1:web', { mic: true })]);
    tick(8_000);
    m.evaluate('r', s, [lkp('u1:web', { mic: true, cam: true })]); // track arrived
    tick(8_000);
    expect(m.evaluate('r', s, [lkp('u1:web', { mic: true })]).corrections).toEqual([]); // clock restarts
  });

  it('a changed claim restarts the debounce', () => {
    const { m, tick } = setup();
    const lk = [lkp('u1:web', { mic: true })];
    m.evaluate('r', [seat({ cam: true })], lk);
    tick(11_000);
    m.evaluate('r', [seat({ cam: false })], lk);
    tick(1_000);
    expect(m.evaluate('r', [seat({ cam: true })], lk).corrections).toEqual([]);
  });

  it('skips a seat that has not signalled anything yet', () => {
    const { m, tick } = setup();
    const s = [seat({ state: undefined })];
    m.evaluate('r', s, [lkp('u1:web', { mic: true })]);
    tick(60_000);
    expect(m.evaluate('r', s, [lkp('u1:web', { mic: true })]).corrections).toEqual([]);
  });
});

describe('no flapping', () => {
  it('a client that keeps re-asserting a false claim is corrected rarely, with growing backoff', () => {
    const { m, tick } = setup();
    const s = [seat({ cam: true })];
    const lk = [lkp('u1:web', { mic: true })];
    const times: number[] = [];
    let elapsed = 0;
    for (let i = 0; i < 90; i++) {
      if (m.evaluate('r', s, lk).corrections.length) times.push(elapsed);
      tick(10_000);
      elapsed += 10_000;
    }
    expect(times.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(DEFAULT_HEALTH_CONFIG.cooldownMs);
      if (i >= 2) expect(times[i]! - times[i - 1]!).toBeGreaterThan(times[i - 1]! - times[i - 2]!);
    }
  });

  it('after the correction applies (claim now matches) nothing more is emitted', () => {
    const { m, tick } = setup();
    const lk = [lkp('u1:web', { mic: true })];
    m.evaluate('r', [seat({ cam: true })], lk);
    tick(15_000);
    expect(m.evaluate('r', [seat({ cam: true })], lk).corrections).toHaveLength(1);
    for (let i = 0; i < 10; i++) {
      tick(10_000);
      expect(m.evaluate('r', [seat({ cam: false })], lk).corrections).toEqual([]);
    }
  });
});

describe('ghost seats', () => {
  it('releases a seat absent from the media engine for longer than ghostMs', () => {
    const { m, tick } = setup();
    const s = [seat({ joinedAt: 0 })];
    expect(m.evaluate('r', s, []).releases).toEqual([]);
    tick(30_000);
    expect(m.evaluate('r', s, []).releases).toEqual([]);
    tick(20_000);
    expect(m.evaluate('r', s, []).releases).toEqual([
      { userId: 'u1', device: 'web', identity: 'u1:web', reason: 'ghost' },
    ]);
  });

  it('gives a fresh joiner the full grace from when it joined', () => {
    const { m, now, tick } = setup();
    m.evaluate('r', [seat({ joinedAt: 0 })], []);
    tick(100_000);
    expect(m.evaluate('r', [seat({ joinedAt: now() - 5_000 })], []).releases).toEqual([]);
  });

  it('forgets the absence once the participant shows up', () => {
    const { m, tick } = setup();
    const s = [seat()];
    m.evaluate('r', s, []);
    tick(40_000);
    m.evaluate('r', s, [lkp('u1:web', { mic: true })]);
    tick(40_000);
    expect(m.evaluate('r', s, []).releases).toEqual([]);
  });

  it('only releases the absent device, not its sibling', () => {
    const { m, tick } = setup();
    const a = seat();
    const b = seat({ device: 'phone', identity: 'u1:phone' });
    const lk = [lkp('u1:web', { mic: true })];
    m.evaluate('r', [a, b], lk);
    tick(50_000);
    expect(m.evaluate('r', [a, b], lk).releases.map((r) => r.identity)).toEqual(['u1:phone']);
  });
});

describe('media engine down', () => {
  it('judges nothing and releases nothing', () => {
    const { m, tick } = setup();
    const s = [seat({ cam: true })];
    for (let i = 0; i < 20; i++) {
      tick(10_000);
      const d = m.evaluate('r', s, null);
      expect(d.checked).toBe(false);
      expect(d.corrections).toEqual([]);
      expect(d.releases).toEqual([]);
    }
  });

  it('does not turn an outage into ghosts: absence timers restart on recovery', () => {
    const { m, tick } = setup();
    const s = [seat()];
    m.evaluate('r', s, []);
    tick(30_000);
    m.evaluate('r', s, null);
    tick(30_000);
    expect(m.evaluate('r', s, []).releases).toEqual([]);
  });
});

describe('watchdog', () => {
  it('releases a socketless device that stopped reporting', () => {
    const { m, now } = setup();
    const s = [
      seat({
        hasSocket: false,
        joinedAt: now() - 100_000,
        state: { mic: true, cam: false, screen: false, reportAt: now() - 95_000 },
      }),
    ];
    expect(m.evaluate('r', s, [lkp('u1:web', { mic: true })]).releases[0]).toMatchObject({
      identity: 'u1:web',
      reason: 'watchdog',
    });
  });

  it('keeps a socketless device that reported recently', () => {
    const { m, now } = setup();
    const s = [seat({ hasSocket: false, state: { mic: true, cam: false, screen: false, reportAt: now() - 20_000 } })];
    expect(m.evaluate('r', s, [lkp('u1:web', { mic: true })]).releases).toEqual([]);
  });

  it('never releases a device that still has a socket, however quiet', () => {
    const { m, now } = setup();
    const s = [
      seat({
        hasSocket: true,
        joinedAt: now() - 1_000_000,
        state: { mic: true, cam: false, screen: false, reportAt: 1 },
      }),
    ];
    expect(m.evaluate('r', s, [lkp('u1:web', { mic: true })]).releases).toEqual([]);
  });

  it('works while the media engine is down', () => {
    const { m, now } = setup();
    const s = [seat({ hasSocket: false, joinedAt: now() - 200_000, state: undefined })];
    expect(m.evaluate('r', s, null).releases[0]!.reason).toBe('watchdog');
  });
});

describe('health vocabulary', () => {
  it('parses only known values and drops garbage', () => {
    expect(parseHealth({ mic: 'silent', cam: 'no-frames' })).toEqual({ mic: 'silent', cam: 'no-frames' });
    expect(parseHealth({ mic: 'bogus', cam: 'bogus' })).toBeUndefined();
    expect(parseHealth('x')).toBeUndefined();
    expect(parseHealth({ mic: 'on', cam: 7 })).toEqual({ mic: 'on', cam: 'off' });
  });

  it.each([
    [{ mic: true, cam: false }, undefined, { mic: 'on', cam: 'off' }],
    [{ mic: false, cam: false }, { mic: 'on', cam: 'no-frames' }, { mic: 'off', cam: 'off' }],
    [{ mic: true, cam: true }, { mic: 'off', cam: 'no-frames' }, { mic: 'on', cam: 'no-frames' }],
    [{ mic: false, cam: false }, { mic: 'restarting', cam: 'failed' }, { mic: 'restarting', cam: 'failed' }],
    [{ mic: true, cam: true }, { mic: 'silent', cam: 'interrupted' }, { mic: 'silent', cam: 'interrupted' }],
  ] as const)('normalizes %j with %j', (flags, h, want) => {
    expect(normalizeHealth(flags, h as never)).toEqual(want);
  });
});
