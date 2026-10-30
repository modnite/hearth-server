import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db, now as clock } from './db.js';

/**
 * Optional two-step sign-in with an authenticator app (RFC 6238: 6 digits, 30 seconds, HMAC-SHA1, the kind every authenticator app speaks).
 * Someone turns it on from their own account; from then on a sign-in needs the password and the current code (or one of eight one-time recovery
 * codes). The secret is kept in the database like the password hash is: whoever can read the database could read it.
 */
db.exec(`CREATE TABLE IF NOT EXISTS user_totp (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret     TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0,
  recovery   TEXT NOT NULL DEFAULT '[]',
  last_step  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)`);

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for one 30 second step (RFC 4226's HOTP with the step as the counter). */
export function codeAt(secret: Buffer, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(counter).digest();
  const offset = h[h.length - 1]! & 15;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepOf = (ms: number) => Math.floor(ms / 1000 / 30);

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The step a code belongs to (this one, or one either side for clocks that drift), or null. */
export function matchStep(secretBase32: string, code: string, ms: number): number | null {
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const secret = fromBase32(secretBase32);
  const now = stepOf(ms);
  for (const step of [now, now - 1, now + 1]) if (same(codeAt(secret, step), clean)) return step;
  return null;
}

export const otpauthUri = (account: string, secretBase32: string, issuer = 'Hearth') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

const hashRecovery = (code: string) => createHash('sha256').update(code.toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');

export function newRecoveryCodes(): string[] {
  return Array.from({ length: 8 }, () => {
    const raw = randomBytes(5).toString('hex'); // 10 hex digits
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

interface Row { user_id: string; secret: string; enabled: number; recovery: string; last_step: number }
const row = (userId: string) => db.prepare('SELECT * FROM user_totp WHERE user_id = ?').get(userId) as Row | undefined;

export function totpStatus(userId: string): { enabled: boolean; recoveryLeft: number } {
  const r = row(userId);
  return { enabled: Boolean(r?.enabled), recoveryLeft: r?.enabled ? (JSON.parse(r.recovery) as string[]).length : 0 };
}

export const isTotpOn = (userId: string) => Boolean(row(userId)?.enabled);

/** Start turning it on: a fresh secret (kept until it is confirmed with a code). Not on yet. */
export function startSetup(userId: string): string {
  const existing = row(userId);
  if (existing?.enabled) throw new Error('already on');
  const secret = base32(randomBytes(20));
  db.prepare('INSERT INTO user_totp (user_id, secret, enabled, recovery, last_step, created_at) VALUES (?, ?, 0, ?, 0, ?) ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, enabled = 0')
    .run(userId, secret, '[]', clock());
  return secret;
}

/** Confirm with a code from the app: it is on, and the recovery codes are made (shown once). Null when the code is wrong. */
export function enable(userId: string, code: string, ms = Date.now()): string[] | null {
  const r = row(userId);
  if (!r || r.enabled) return null;
  const step = matchStep(r.secret, code, ms);
  if (step === null) return null;
  const codes = newRecoveryCodes();
  db.prepare('UPDATE user_totp SET enabled = 1, recovery = ?, last_step = ? WHERE user_id = ?').run(JSON.stringify(codes.map(hashRecovery)), step, userId);
  return codes;
}

/** A sign-in's second step: the current code (each step only once) or a recovery code (each only once). */
export function checkSecondStep(userId: string, code: string, ms = Date.now()): boolean {
  const r = row(userId);
  if (!r?.enabled) return true;
  const step = matchStep(r.secret, code, ms);
  if (step !== null) {
    if (step <= r.last_step) return false; // that code was already used
    db.prepare('UPDATE user_totp SET last_step = ? WHERE user_id = ?').run(step, userId);
    return true;
  }
  const hashes = JSON.parse(r.recovery) as string[];
  const h = hashRecovery(code);
  const at = hashes.indexOf(h);
  if (at < 0) return false;
  hashes.splice(at, 1);
  db.prepare('UPDATE user_totp SET recovery = ? WHERE user_id = ?').run(JSON.stringify(hashes), userId);
  return true;
}

export function disable(userId: string): void {
  db.prepare('DELETE FROM user_totp WHERE user_id = ?').run(userId);
}
