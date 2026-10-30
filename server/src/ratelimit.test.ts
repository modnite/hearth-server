import { describe, expect, it } from 'vitest';
import { FailureLimiter } from './ratelimit.js';

describe('FailureLimiter', () => {
  it('blocks after max failures and unblocks after the window', () => {
    const l = new FailureLimiter(3, 1000);
    for (let i = 0; i < 3; i += 1) {
      expect(l.blockedFor('a', 0)).toBe(0);
      l.fail('a', i);
    }
    expect(l.blockedFor('a', 10)).toBeGreaterThan(0);
    expect(l.blockedFor('b', 10)).toBe(0);
    expect(l.blockedFor('a', 1001)).toBe(0);
  });

  it('reset clears the key', () => {
    const l = new FailureLimiter(1, 1000);
    l.fail('a', 0);
    expect(l.blockedFor('a', 1)).toBeGreaterThan(0);
    l.reset('a');
    expect(l.blockedFor('a', 1)).toBe(0);
  });
});
