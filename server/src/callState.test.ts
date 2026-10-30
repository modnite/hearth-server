import { describe, it, expect } from 'vitest';
import { CallStates, callIdentity, stateBelongsTo, type MediaState } from './callState.js';

const desktop: MediaState = { mic: false, cam: true, screen: false };
const phone: MediaState = { mic: true, cam: false, screen: false };

describe('callIdentity', () => {
  it('joins the user and device with a colon', () => {
    expect(callIdentity('u1', 'desktop')).toBe('u1:desktop');
  });

  it('keeps the user and device distinguishable in the key', () => {
    expect(callIdentity('user-42', 'phone')).toBe('user-42:phone');
  });
});

describe('stateBelongsTo', () => {
  it('accepts a key whose user part is the given user', () => {
    expect(stateBelongsTo('u1:phone', 'u1')).toBe(true);
  });

  it('rejects another user who shares a prefix', () => {
    // `u1` must not swallow `u10`'s state just because the string starts alike.
    expect(stateBelongsTo('u10:phone', 'u1')).toBe(false);
  });

  it('rejects a bare key with no device part', () => {
    expect(stateBelongsTo('u1', 'u1')).toBe(true);
    expect(stateBelongsTo('u10', 'u1')).toBe(false);
  });

  it('rejects a key belonging to a different user entirely', () => {
    expect(stateBelongsTo('u2:desktop', 'u1')).toBe(false);
  });
});

describe('CallStates per-device state', () => {
  it('keeps two devices of one user independent (regression)', () => {
    const states = new CallStates();

    // Desktop mutes; then the phone reports it is unmuted.
    states.set('u1', 'desktop', { mic: false, cam: true, screen: false });
    states.set('u1', 'phone', { mic: true, cam: false, screen: false });

    // Neither report overwrote the other.
    expect(states.get('u1', 'desktop')).toEqual({ mic: false, cam: true, screen: false });
    expect(states.get('u1', 'phone')).toEqual({ mic: true, cam: false, screen: false });
    expect(states.size).toBe(2);
  });

  it('updates only the reporting device when it reports again', () => {
    const states = new CallStates();
    states.set('u1', 'desktop', desktop);
    states.set('u1', 'phone', phone);

    states.set('u1', 'phone', { mic: false, cam: true, screen: true });

    expect(states.get('u1', 'desktop')).toEqual(desktop);
    expect(states.get('u1', 'phone')).toEqual({ mic: false, cam: true, screen: true });
  });

  it('returns undefined for a device that has never reported', () => {
    const states = new CallStates();
    expect(states.get('u1', 'tablet')).toBeUndefined();
  });
});

describe('CallStates.deleteDevice', () => {
  it('removes only that device and keeps the other device', () => {
    const states = new CallStates();
    states.set('u1', 'desktop', desktop);
    states.set('u1', 'phone', phone);

    states.deleteDevice('u1', 'desktop');

    expect(states.get('u1', 'desktop')).toBeUndefined();
    expect(states.get('u1', 'phone')).toEqual(phone);
    expect(states.size).toBe(1);
  });

  it('does not disturb a device of another user', () => {
    const states = new CallStates();
    states.set('u1', 'desktop', desktop);
    states.set('u2', 'desktop', phone);

    states.deleteDevice('u1', 'desktop');

    expect(states.get('u2', 'desktop')).toEqual(phone);
  });
});

describe('CallStates.deleteUser', () => {
  it('removes every device of the user and leaves other users alone', () => {
    const states = new CallStates();
    states.set('u1', 'desktop', desktop);
    states.set('u1', 'phone', phone);
    states.set('u2', 'desktop', desktop);

    states.deleteUser('u1');

    expect(states.get('u1', 'desktop')).toBeUndefined();
    expect(states.get('u1', 'phone')).toBeUndefined();
    expect(states.get('u2', 'desktop')).toEqual(desktop);
    expect(states.size).toBe(1);
  });

  it('does not remove a prefix-sharing user', () => {
    const states = new CallStates();
    states.set('u1', 'phone', phone);
    states.set('u10', 'phone', desktop);

    states.deleteUser('u1');

    expect(states.get('u1', 'phone')).toBeUndefined();
    expect(states.get('u10', 'phone')).toEqual(desktop);
  });
});

describe('CallStates.toJSON', () => {
  it('returns the identity-keyed record that call.active broadcasts', () => {
    const states = new CallStates();
    states.set('u1', 'desktop', desktop);
    states.set('u1', 'phone', phone);
    states.set('u2', 'web', { mic: true, cam: true, screen: true });

    expect(states.toJSON()).toEqual({
      'u1:desktop': desktop,
      'u1:phone': phone,
      'u2:web': { mic: true, cam: true, screen: true },
    });
  });

  it('is empty before anything is reported', () => {
    expect(new CallStates().toJSON()).toEqual({});
  });
});
