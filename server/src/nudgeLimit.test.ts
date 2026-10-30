import { describe, expect, it } from 'vitest';
import { NUDGE_BURST, NUDGE_REFILL_MS, allowNudge } from './nudgeLimit.js';

describe('nudge rate limit', () => {
  it('lets a few nudges through at once', () => {
    let sent = 0;
    for (let i = 0; i < NUDGE_BURST; i++) if (allowNudge('u1', 'r1', 1_000)) sent++;
    expect(sent).toBe(NUDGE_BURST);
  });

  it('drops a flood: an autoclicker gets the burst and then one every refill period', () => {
    let sent = 0;
    // 30 clicks a second for a minute
    for (let t = 0; t < 60_000; t += 33) if (allowNudge('u2', 'r1', 5_000 + t)) sent++;
    expect(sent).toBeLessThanOrEqual(NUDGE_BURST + Math.ceil(60_000 / NUDGE_REFILL_MS));
    expect(sent).toBeGreaterThanOrEqual(NUDGE_BURST);
  });

  it('gives the allowance back after a pause', () => {
    for (let i = 0; i < 10; i++) allowNudge('u3', 'r1', 0);
    expect(allowNudge('u3', 'r1', 1)).toBe(false);
    expect(allowNudge('u3', 'r1', NUDGE_REFILL_MS + 10)).toBe(true);
    expect(allowNudge('u3', 'r1', NUDGE_REFILL_MS * 20)).toBe(true);
  });

  it('counts each sender and each room on its own', () => {
    for (let i = 0; i < 10; i++) allowNudge('u4', 'r1', 0);
    expect(allowNudge('u4', 'r1', 10)).toBe(false);
    expect(allowNudge('u4', 'r2', 10)).toBe(true);
    expect(allowNudge('u5', 'r1', 10)).toBe(true);
  });
});
