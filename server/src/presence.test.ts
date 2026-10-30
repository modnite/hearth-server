import { describe, expect, it } from 'vitest';
import { isActivelyPresent } from './presence.js';

describe('isActivelyPresent', () => {
  it('is false with no connections at all', () => {
    expect(isActivelyPresent([])).toBe(false);
  });

  it('is false when every connection is a backgrounded tab', () => {
    // The regression: these sockets are open, so the old check called the user
    // "online" and never pushed.
    expect(isActivelyPresent([{ visible: false }])).toBe(false);
    expect(isActivelyPresent([{ visible: false }, { visible: false }])).toBe(false);
  });

  it('is true when one tab is on screen', () => {
    expect(isActivelyPresent([{ visible: true }])).toBe(true);
  });

  it('is true when any one of several tabs is on screen', () => {
    expect(isActivelyPresent([{ visible: false }, { visible: true }, { visible: false }])).toBe(true);
  });

  it('does not depend on the order of the connections', () => {
    expect(isActivelyPresent([{ visible: true }, { visible: false }])).toBe(true);
    expect(isActivelyPresent([{ visible: false }, { visible: true }])).toBe(true);
  });
});
