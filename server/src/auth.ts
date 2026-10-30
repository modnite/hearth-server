import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db, now, type UserRow } from './db.js';
import { purgeNativeNotifications, revokeNativeSession } from './nativeQueue.js';

const SESSION_COOKIE = 'hearth_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(expected, actual);
}

/** Drop expired sessions; called at boot and hourly. */
export function purgeExpiredSessions(): void {
  purgeNativeNotifications();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
  db.prepare('DELETE FROM remember_tokens WHERE expires_at <= ?').run(now());
}

export function createSession(userId: string, reply: FastifyReply): void {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = now() + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    now(),
    expires,
  );
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Secure only when the request really came over HTTPS (directly or through a proxy that says so), so a server reached over plain
    // HTTP on a home network still works; a browser would drop a Secure cookie there and nobody could sign in.
    secure: reply.request.protocol === 'https',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function destroySession(token: string, reply: FastifyReply): void {
  revokeNativeSession(token);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

function tokenFromCookieHeader(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function userFromToken(token: string | null): UserRow | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ? AND u.disabled = 0`,
    )
    .get(token, now()) as UserRow | undefined;
  return row ?? null;
}

export function currentUser(req: FastifyRequest): UserRow | null {
  return userFromToken(tokenFromCookieHeader(req.headers.cookie));
}

export function requireUser(req: FastifyRequest, reply: FastifyReply): UserRow | null {
  const user = currentUser(req);
  if (!user) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  return user;
}

export { SESSION_COOKIE, tokenFromCookieHeader };


// ---- "Remember me on this device" ----------------------------------------------------------------
export const REMEMBER_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const sha256 = (v: string): string => crypto.createHash('sha256').update(v).digest('hex');

/** A new remembered device for this user: returns its public id and the secret (shown once, stored only hashed). */
export function createRememberToken(userId: string, label: string): { id: string; token: string } {
  const id = crypto.randomBytes(9).toString('base64url');
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  db.prepare(
    'INSERT INTO remember_tokens (id, user_id, token_hash, label, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, userId, sha256(token), label.slice(0, 80), t, t, t + REMEMBER_TTL_MS);
  return { id, token };
}

/** Use a remembered device's secret: returns the user id and a NEW secret (the old one stops working), or null. */
export function redeemRememberToken(id: string, token: string): { userId: string; token: string } | null {
  const row = db.prepare('SELECT * FROM remember_tokens WHERE id = ?').get(id) as
    | { user_id: string; token_hash: string; expires_at: number }
    | undefined;
  if (!row || row.expires_at <= now()) return null;
  const given = Buffer.from(sha256(token), 'hex');
  const stored = Buffer.from(row.token_hash, 'hex');
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) return null;
  const next = crypto.randomBytes(32).toString('base64url');
  const t = now();
  db.prepare('UPDATE remember_tokens SET token_hash = ?, last_used_at = ?, expires_at = ? WHERE id = ?').run(
    sha256(next),
    t,
    t + REMEMBER_TTL_MS,
    id,
  );
  return { userId: row.user_id, token: next };
}

/** Forget a remembered device. With the secret (proof you hold it) or as the signed-in owner. */
export function forgetRememberToken(id: string, proof: { token?: string; userId?: string }): boolean {
  const row = db.prepare('SELECT * FROM remember_tokens WHERE id = ?').get(id) as
    | { user_id: string; token_hash: string }
    | undefined;
  if (!row) return false;
  const byOwner = proof.userId !== undefined && proof.userId === row.user_id;
  let byToken = false;
  if (proof.token) {
    const a = Buffer.from(sha256(proof.token), 'hex');
    const b = Buffer.from(row.token_hash, 'hex');
    byToken = a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (!byOwner && !byToken) return false;
  db.prepare('DELETE FROM remember_tokens WHERE id = ?').run(id);
  return true;
}

export function purgeExpiredRememberTokens(): void {
  db.prepare('DELETE FROM remember_tokens WHERE expires_at <= ?').run(now());
}
