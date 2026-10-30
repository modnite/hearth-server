import { describe, expect, it } from 'vitest';
import { base32, codeAt, fromBase32, matchStep, newRecoveryCodes, otpauthUri, stepOf } from './totp.js';

describe('two-step codes', () => {
  it('matches the RFC 6238 test vectors (SHA-1, secret 12345678901234567890)', () => {
    const secret = Buffer.from('12345678901234567890');
    // the RFC lists 8-digit codes; the 6-digit code is their last six digits
    const table: Array<[number, string]> = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']];
    for (const [t, eight] of table) {
      expect(codeAt(secret, stepOf(t * 1000), 8)).toBe(eight);
      expect(codeAt(secret, stepOf(t * 1000))).toBe(eight.slice(2));
    }
  });

  it('reads and writes base32 the way authenticator apps do', () => {
    expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(fromBase32('MZXW6YTBOI').toString()).toBe('foobar');
    expect(fromBase32('mzxw 6ytb-oi').toString()).toBe('foobar');
    const raw = Buffer.from(Array.from({ length: 20 }, (_, i) => i * 13));
    expect(fromBase32(base32(raw)).equals(raw)).toBe(true);
  });

  it('accepts the current code and one step either side, nothing else', () => {
    const secret = base32(Buffer.from('12345678901234567890'));
    const ms = 1111111109 * 1000;
    const now = stepOf(ms);
    const raw = Buffer.from('12345678901234567890');
    expect(matchStep(secret, codeAt(raw, now), ms)).toBe(now);
    expect(matchStep(secret, codeAt(raw, now - 1), ms)).toBe(now - 1);
    expect(matchStep(secret, codeAt(raw, now + 1), ms)).toBe(now + 1);
    expect(matchStep(secret, codeAt(raw, now - 2), ms)).toBeNull();
    expect(matchStep(secret, '12345', ms)).toBeNull();
    expect(matchStep(secret, 'abcdef', ms)).toBeNull();
    expect(matchStep(secret, ` ${codeAt(raw, now).slice(0, 3)} ${codeAt(raw, now).slice(3)} `, ms)).toBe(now);
  });

  it('makes eight different recovery codes in a form people can type', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const c of codes) expect(c).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}$/);
  });

  it('builds the address an authenticator app scans', () => {
    const u = otpauthUri('alex@chat', 'JBSWY3DPEHPK3PXP');
    expect(u).toBe('otpauth://totp/Hearth:alex%40chat?secret=JBSWY3DPEHPK3PXP&issuer=Hearth&algorithm=SHA1&digits=6&period=30');
  });
});
