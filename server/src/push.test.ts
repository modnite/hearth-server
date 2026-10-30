import { describe, expect, it } from 'vitest';
import { buildSendOptions, isValidSubscription } from './push.js';

const good = {
  endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc',
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
};

describe('isValidSubscription', () => {
  it('accepts a normal browser subscription', () => {
    expect(isValidSubscription(good)).toBe(true);
  });
  it('rejects what could never be sent to', () => {
    expect(isValidSubscription(null)).toBe(false);
    expect(isValidSubscription({})).toBe(false);
    expect(isValidSubscription({ ...good, endpoint: 'http://insecure.example/x' })).toBe(false);
    expect(isValidSubscription({ ...good, keys: { p256dh: 'x', auth: 'y' } })).toBe(false);
    expect(isValidSubscription({ endpoint: good.endpoint })).toBe(false);
  });
});

describe('buildSendOptions', () => {
  it('lets a message wait a day and a ring only a minute, and wakes the phone for rings', () => {
    expect(buildSendOptions({ title: 't', body: 'b' })).toMatchObject({ TTL: 86400, urgency: 'normal' });
    expect(buildSendOptions({ title: 't', body: 'b', urgent: true })).toMatchObject({ TTL: 60, urgency: 'high' });
  });
  it('collapses pushes for one room onto one short, url-safe topic', () => {
    const a = buildSendOptions({ title: 't', body: 'b', tag: 'room-1' }).topic!;
    const b = buildSendOptions({ title: 't', body: 'b', tag: 'room-1' }).topic!;
    const c = buildSendOptions({ title: 't', body: 'b', tag: 'room-2' }).topic!;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.length).toBeLessThanOrEqual(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(buildSendOptions({ title: 't', body: 'b' }).topic).toBeUndefined();
  });
});
