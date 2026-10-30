import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, now, publicUser, type UserRow } from './db.js';
import { hashPassword, tokenFromCookieHeader, verifyPassword } from './auth.js';
import { revokeNativeSession } from './nativeQueue.js';
import { FailureLimiter } from './ratelimit.js';
import { contactRow, removeContact, visibleUserIds } from './contacts.js';

/**
 * Accounts and people: changing a username or password, friend codes, finding someone to add, and blocking.
 * Everything here is additive: it adds tables and one column and leaves the existing sign-in and contact rules as they were.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS blocks (
  blocker    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker, blocked)
);
-- Hashes of passwords an account used before, so a password cannot come back.
CREATE TABLE IF NOT EXISTS password_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS password_history_user ON password_history(user_id);
`);
if (!(db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).some((c) => c.name === 'friend_code')) {
  db.exec('ALTER TABLE users ADD COLUMN friend_code TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_friend_code ON users(friend_code)');
if (!(db.prepare('PRAGMA table_info(room_members)').all() as { name: string }[]).some((c) => c.name === 'archived')) {
  db.exec('ALTER TABLE room_members ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
}

// ---------------------------------------------------------------- archived chats
// Per person, like WhatsApp: an archived chat leaves the main list and stops notifying, its unread count keeps counting, and it stays archived
// when new messages arrive. Nobody else sees that you archived it.
export const isArchived = (roomId: string, userId: string): boolean =>
  Boolean((db.prepare('SELECT archived FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, userId) as { archived: number } | undefined)?.archived);

export const setArchived = (roomId: string, userId: string, archived: boolean): boolean =>
  db.prepare('UPDATE room_members SET archived = ? WHERE room_id = ? AND user_id = ?').run(archived ? 1 : 0, roomId, userId).changes > 0;

// ---------------------------------------------------------------- friend codes
// Six characters without 0/O/1/I/L, so a code read aloud or off a screen is hard to get wrong. Shown as ABC-123.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export function newFriendCode(): string {
  for (;;) {
    let code = '';
    for (const byte of crypto.randomBytes(CODE_LENGTH)) code += CODE_CHARS[byte % CODE_CHARS.length];
    if (!db.prepare('SELECT 1 FROM users WHERE friend_code = ?').get(code)) return code;
  }
}

/** "abc 123", "ABC-123" and "abc123" are the same code. Returns null when it cannot be one. */
export function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_CHARS.includes(ch)) return null;
  return code;
}

export const showCode = (code: string) => `${code.slice(0, 3)}-${code.slice(3)}`;

export function friendCodeOf(userId: string): string {
  const row = db.prepare('SELECT friend_code FROM users WHERE id = ?').get(userId) as { friend_code: string | null } | undefined;
  if (row?.friend_code) return row.friend_code;
  const code = newFriendCode();
  db.prepare('UPDATE users SET friend_code = ? WHERE id = ? AND friend_code IS NULL').run(code, userId);
  return (db.prepare('SELECT friend_code FROM users WHERE id = ?').get(userId) as { friend_code: string }).friend_code;
}

for (const { id } of db.prepare('SELECT id FROM users WHERE friend_code IS NULL').all() as { id: string }[]) friendCodeOf(id);

/** Who a name or a code belongs to. A single box takes either: a username wins, then a code. */
export function findUser(query: string, only?: 'username' | 'code'): UserRow | undefined {
  const q = query.trim().replace(/^@/, '');
  if (!q) return undefined;
  if (only !== 'code') {
    const byName = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(q) as UserRow | undefined;
    if (byName) return byName;
    if (only === 'username') return undefined;
  }
  const code = normalizeCode(q);
  return code ? (db.prepare('SELECT * FROM users WHERE friend_code = ?').get(code) as UserRow | undefined) : undefined;
}

// ---------------------------------------------------------------- blocking
export const hasBlocked = (blocker: string, other: string): boolean => Boolean(db.prepare('SELECT 1 FROM blocks WHERE blocker = ? AND blocked = ?').get(blocker, other));

/** True when either of the two has blocked the other. */
export const blockedEitherWay = (x: string, y: string): boolean => hasBlocked(x, y) || hasBlocked(y, x);

export const blockedIds = (me: string): string[] => (db.prepare('SELECT blocked FROM blocks WHERE blocker = ? ORDER BY created_at DESC').all(me) as { blocked: string }[]).map((r) => r.blocked);

export function blockUser(me: string, other: string): boolean {
  if (me === other) return false;
  db.prepare('INSERT OR IGNORE INTO blocks (blocker, blocked, created_at) VALUES (?, ?, ?)').run(me, other, now());
  // Blocking ends any friendship and cancels any request in either direction.
  removeContact(me, other);
  return true;
}

export const unblockUser = (me: string, other: string): boolean => db.prepare('DELETE FROM blocks WHERE blocker = ? AND blocked = ?').run(me, other).changes > 0;

/** In a chat of exactly two people, has either blocked the other? Used to stop messages going through. */
export function dmBlocked(roomId: string, sender: string): boolean {
  const room = db.prepare('SELECT kind FROM rooms WHERE id = ?').get(roomId) as { kind: string } | undefined;
  if (room?.kind !== 'dm') return false;
  const others = (db.prepare('SELECT user_id FROM room_members WHERE room_id = ? AND user_id != ?').all(roomId, sender) as { user_id: string }[]).map((r) => r.user_id);
  return others.length === 1 && blockedEitherWay(sender, others[0]!);
}

// ---------------------------------------------------------------- usernames
export const USERNAME_RULE = '3 to 24 letters, numbers, dots, dashes or underscores';
export const validUsername = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z0-9._-]{3,24}$/.test(name);

/** Is the name free right now? Names are not reserved: a name someone gave up is free to anyone, including them. */
export function usernameFree(name: string, exceptUserId?: string): boolean {
  const row = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(name) as { id: string } | undefined;
  return !row || row.id === exceptUserId;
}

// ---------------------------------------------------------------- passwords
export const MIN_PASSWORD = 8;
const HISTORY_KEPT = 10;

/** Has this account used this password, now or before? */
export function passwordUsedBefore(user: UserRow, password: string): boolean {
  if (verifyPassword(password, user.password_hash)) return true;
  const rows = db.prepare('SELECT hash FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(user.id, HISTORY_KEPT) as { hash: string }[];
  return rows.some((r) => verifyPassword(password, r.hash));
}

/** Keep the old hash, set the new password, and sign every other session out. Returns the new hash. */
export function setNewPassword(user: UserRow, password: string, keepToken: string | null): void {
  db.transaction(() => {
    if (user.password_hash && user.password_hash !== 'scrypt$00$00') {
      db.prepare('INSERT INTO password_history (user_id, hash, created_at) VALUES (?, ?, ?)').run(user.id, user.password_hash, now());
      db.prepare('DELETE FROM password_history WHERE user_id = ? AND id NOT IN (SELECT id FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?)').run(user.id, user.id, HISTORY_KEPT);
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
    const others = db.prepare('SELECT token FROM sessions WHERE user_id = ? AND token != ?').all(user.id, keepToken ?? '') as { token: string }[];
    for (const { token } of others) revokeNativeSession(token);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, keepToken ?? '');
    db.prepare('DELETE FROM remember_tokens WHERE user_id = ?').run(user.id);
  })();
}

// ---------------------------------------------------------------- routes
export interface SocialDeps {
  requireUser: (req: FastifyRequest, reply: FastifyReply) => UserRow | null;
  /** Check the current password the way sign-in does. */
  checkPassword: (user: UserRow, password: unknown) => boolean;
  tell: (userId: string, message: object) => void;
  presence: (userId: string) => void;
}

const lookupLimit = new FailureLimiter(40, 60_000);
const passwordLimit = new FailureLimiter(8, 15 * 60_000);
const renameLimit = new FailureLimiter(5, 24 * 60 * 60_000);

const card = (u: UserRow) => {
  const v = publicUser(u);
  return { id: v.id, username: v.username, displayName: v.displayName, avatarColor: v.avatarColor, avatar: v.avatar };
};

export function registerSocial(app: FastifyInstance, deps: SocialDeps): void {
  const { requireUser, checkPassword, tell, presence } = deps;
  const changed = (...ids: string[]) => {
    for (const id of ids) tell(id, { t: 'contacts.changed' });
  };

  // ---- my username
  app.post('/api/auth/username', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const wait = Math.max(passwordLimit.blockedFor(me.id), renameLimit.blockedFor(me.id));
    if (wait) return reply.code(429).header('retry-after', String(wait)).send({ error: 'too many tries, wait a bit' });
    if (!checkPassword(me, body.password)) {
      passwordLimit.fail(me.id);
      return reply.code(403).send({ error: 'that is not your current password' });
    }
    const name = typeof body.username === 'string' ? body.username.trim() : '';
    if (!validUsername(name)) return reply.code(400).send({ error: `a username is ${USERNAME_RULE}` });
    if (name === me.username) return reply.code(400).send({ error: 'that is already your username' });
    if (!usernameFree(name, me.id)) return reply.code(409).send({ error: 'that username is taken' });
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(name, me.id);
    renameLimit.fail(me.id);
    passwordLimit.reset(me.id);
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(me.id) as UserRow;
    changed(...visibleUserIds(me.id));
    presence(me.id);
    return { user: publicUser(updated) };
  });

  // ---- my password
  app.post('/api/auth/change-password', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const wait = passwordLimit.blockedFor(me.id);
    if (wait) return reply.code(429).header('retry-after', String(wait)).send({ error: 'too many tries, wait a bit' });
    if (!checkPassword(me, body.current)) {
      passwordLimit.fail(me.id);
      return reply.code(403).send({ error: 'that is not your current password' });
    }
    const next = body.next;
    if (typeof next !== 'string' || next.length < MIN_PASSWORD) return reply.code(400).send({ error: `a password needs ${MIN_PASSWORD} or more characters` });
    if (next.length > 200) return reply.code(400).send({ error: 'that password is too long' });
    // An account that signs in with a vault login secret changes its password from the vault settings, not here.
    if ((me as { login_hash?: string | null }).login_hash) return reply.code(409).send({ error: 'this account changes its password from the vault settings' });
    if (passwordUsedBefore(me, next)) return reply.code(409).send({ error: 'you have used that password before, choose a new one', reused: true });
    setNewPassword(me, next, tokenFromCookieHeader(req.headers.cookie));
    passwordLimit.reset(me.id);
    return { ok: true };
  });

  // ---- my friend code
  app.get('/api/friend-code', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const code = friendCodeOf(me.id);
    return { code, display: showCode(code) };
  });

  // A new code, if the old one got around further than you would like. Requests already made stay.
  app.post('/api/friend-code', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const code = newFriendCode();
    db.prepare('UPDATE users SET friend_code = ? WHERE id = ?').run(code, me.id);
    return { code, display: showCode(code) };
  });

  // ---- find someone: an exact username or friend code, never a directory
  app.get('/api/users/lookup', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const wait = lookupLimit.blockedFor(me.id);
    if (wait) return reply.code(429).header('retry-after', String(wait)).send({ error: 'too many searches, wait a bit' });
    lookupLimit.fail(me.id);
    const q = String((req.query as { q?: unknown }).q ?? '');
    const other = findUser(q);
    if (!other || blockedEitherWay(me.id, other.id)) return { user: null };
    if (other.id === me.id) return { user: card(other), relation: 'self' };
    const row = contactRow(me.id, other.id);
    const relation = !row ? 'none' : row.status === 'accepted' ? 'contact' : row.requested_by === me.id ? 'outgoing' : 'incoming';
    return { user: card(other), relation };
  });

  // ---- blocking
  app.get('/api/blocks', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const users = blockedIds(me.id)
      .map((id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined)
      .filter((u): u is UserRow => Boolean(u))
      .map(card);
    return { blocked: users };
  });

  app.post('/api/blocks', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const id = String(((req.body ?? {}) as { userId?: unknown }).userId ?? '');
    const other = db.prepare('SELECT id FROM users WHERE id = ?').get(id) as { id: string } | undefined;
    if (!other || other.id === me.id) return reply.code(400).send({ error: 'bad user' });
    blockUser(me.id, other.id);
    changed(me.id, other.id);
    presence(me.id);
    presence(other.id);
    return { ok: true };
  });

  app.delete('/api/blocks/:id', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    unblockUser(me.id, (req.params as { id: string }).id);
    changed(me.id);
    return { ok: true };
  });
}
