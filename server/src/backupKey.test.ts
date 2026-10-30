import { describe, expect, it } from 'vitest';
import { fingerprint, makeBackupKey } from './backupKey.js';

describe('backup key', () => {
  it('is 32 random bytes with a short fingerprint', () => {
    const k = makeBackupKey();
    expect(Buffer.from(k.key, 'base64')).toHaveLength(32);
    expect(k.id).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprint(k.key)).toBe(k.id);
  });

  it('is different every time', () => {
    expect(makeBackupKey().key).not.toBe(makeBackupKey().key);
  });
});
