import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';

fs.mkdirSync(env.DATA_DIR, { recursive: true });

export const uploadsDir = path.join(env.DATA_DIR, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

export const db = new Database(path.join(env.DATA_DIR, 'hearth.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const hadContacts = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'contacts'").get());

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_color  TEXT NOT NULL DEFAULT '#7c6cff',
  avatar        TEXT NOT NULL DEFAULT '',
  wallpaper     TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'offline',
  status_preset TEXT NOT NULL DEFAULT 'online',
  status_message TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  disabled      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- "Remember me on this device": one row per remembered device. The secret token is only ever stored hashed, is
-- single use (rotated on every login with it) and expires after 90 days without use.
CREATE TABLE IF NOT EXISTS remember_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  used_by    TEXT,
  used_at    INTEGER
);

-- Who may see whom. One row per pair (user_a < user_b): 'pending' until the person who did not ask accepts.
CREATE TABLE IF NOT EXISTS contacts (
  user_a       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b)
);

CREATE TABLE IF NOT EXISTS rooms (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,             -- 'group' | 'dm'
  name       TEXT NOT NULL DEFAULT '',
  topic      TEXT NOT NULL DEFAULT '',
  avatar     TEXT NOT NULL DEFAULT '',
  encrypted  INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at    INTEGER NOT NULL,
  last_read_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  edited_at  INTEGER,
  deleted_at INTEGER,
  reply_to   TEXT,
  forwarded  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);

CREATE TABLE IF NOT EXISTS room_pins (
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, message_id)
);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS attachments (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  room_id    TEXT NOT NULL,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  width      INTEGER,
  height     INTEGER,
  encrypted  INTEGER NOT NULL DEFAULT 0,
  envelope   TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT UNIQUE NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Native receivers have a narrow notification-only secret, tied to the login
-- which enabled them. Deleting/expiring that login revokes the receiver too.
CREATE TABLE IF NOT EXISTS native_notification_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_enqueued INTEGER NOT NULL DEFAULT 0,
  last_delivered INTEGER NOT NULL DEFAULT 0,
  last_acked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_native_devices_user ON native_notification_devices(user_id, created_at);
CREATE TABLE IF NOT EXISTS native_notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES native_notification_devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('notification', 'cancel')),
  tag TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_native_events_device ON native_notification_events(device_id, id);
CREATE INDEX IF NOT EXISTS idx_native_events_expiry ON native_notification_events(expires_at);

-- Forward-secret E2EE: each device has an X25519 public key, and the random
-- group key is wrapped to each device (ciphertext it alone can open).
CREATE TABLE IF NOT EXISTS e2ee_devices (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS e2ee_wraps (
  recipient_device TEXT NOT NULL,
  sender_device    TEXT NOT NULL,
  key_id           TEXT NOT NULL,
  ephemeral        TEXT NOT NULL,
  nonce            TEXT NOT NULL,
  ciphertext       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (recipient_device, sender_device, key_id)
);
`);

export const now = () => Date.now();

// --- lightweight migrations for databases created by an earlier version ---
function hasColumn(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}
if (!hasColumn('rooms', 'encrypted')) {
  db.exec('ALTER TABLE rooms ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0');
}
if (!hasColumn('rooms', 'avatar')) {
  db.exec("ALTER TABLE rooms ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
}
if (!hasColumn('users', 'avatar')) {
  db.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
}
if (!hasColumn('users', 'is_admin')) {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
}
if (!hasColumn('users', 'disabled')) {
  db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
}
// A server that existed before the admin panel has no admin yet: the oldest account is the one that set it up.
if (!db.prepare('SELECT 1 FROM users WHERE is_admin = 1').get()) {
  db.exec('UPDATE users SET is_admin = 1 WHERE id = (SELECT id FROM users ORDER BY created_at ASC, rowid ASC LIMIT 1)');
}
if (!hasColumn('users', 'wallpaper')) {
  db.exec("ALTER TABLE users ADD COLUMN wallpaper TEXT NOT NULL DEFAULT ''");
}
if (!hasColumn('users', 'status_preset')) {
  db.exec("ALTER TABLE users ADD COLUMN status_preset TEXT NOT NULL DEFAULT 'online'");
}
if (!hasColumn('attachments', 'encrypted')) {
  db.exec('ALTER TABLE attachments ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0');
}
if (!hasColumn('attachments', 'envelope')) {
  db.exec("ALTER TABLE attachments ADD COLUMN envelope TEXT NOT NULL DEFAULT ''");
}
if (!hasColumn('messages', 'reply_to')) {
  db.exec('ALTER TABLE messages ADD COLUMN reply_to TEXT');
}
if (!hasColumn('messages', 'forwarded')) {
  db.exec('ALTER TABLE messages ADD COLUMN forwarded INTEGER NOT NULL DEFAULT 0');
}

// When contacts first appear, keep today's relationships: everyone who already shares a chat, and each invite's two ends, become contacts.
// Anyone else stops seeing each other, which is the point.
if (!hadContacts) {
  const add = db.prepare("INSERT OR IGNORE INTO contacts (user_a, user_b, requested_by, status, created_at) VALUES (?, ?, ?, 'accepted', ?)");
  const pairs = db
    .prepare(
      `SELECT DISTINCT a.user_id AS x, b.user_id AS y FROM room_members a
       JOIN room_members b ON b.room_id = a.room_id AND b.user_id <> a.user_id`,
    )
    .all() as { x: string; y: string }[];
  const invites = db.prepare('SELECT created_by AS x, used_by AS y FROM invites WHERE used_by IS NOT NULL').all() as { x: string; y: string }[];
  for (const { x, y } of [...pairs, ...invites]) add.run(x < y ? x : y, x < y ? y : x, x, Date.now());
}

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  avatar_color: string;
  avatar: string;
  wallpaper: string;
  status: string;
  /** The status the user chose (online/away/busy/invisible), restored on reconnect. */
  status_preset: string;
  status_message: string;
  created_at: number;
  is_admin: number;
  disabled: number;
}

export interface MessageRow {
  id: string;
  room_id: string;
  user_id: string;
  body: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  reply_to: string | null;
  forwarded: number;
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarColor: u.avatar_color,
    avatar: u.avatar ? `/api/avatars/${u.avatar}` : null,
    wallpaper: u.wallpaper || null,
    status: u.status,
    statusMessage: u.status_message,
  };
}

export function isMember(roomId: string, userId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?')
    .get(roomId, userId);
  return Boolean(row);
}

export function memberIds(roomId: string): string[] {
  return (db.prepare('SELECT user_id FROM room_members WHERE room_id = ?').all(roomId) as {
    user_id: string;
  }[]).map((r) => r.user_id);
}

export function attachmentsFor(messageId: string) {
  return db
    .prepare(
      'SELECT id, filename, mime, size, width, height, encrypted, envelope FROM attachments WHERE message_id = ? ORDER BY created_at',
    )
    .all(messageId);
}

export function reactionsFor(messageId: string) {
  return db
    .prepare('SELECT user_id, emoji FROM reactions WHERE message_id = ? ORDER BY created_at')
    .all(messageId) as { user_id: string; emoji: string }[];
}

/**
 * Delete a message for good: its text, its pictures and files (from disk too), its reactions and its pin. Replies that quoted it lose the
 * quote. Nothing is left behind, not even a "this message was deleted" line.
 */
export function eraseMessage(id: string): void {
  const files = db.prepare('SELECT id FROM attachments WHERE message_id = ?').all(id) as { id: string }[];
  const wipe = db.transaction(() => {
    db.prepare('DELETE FROM reactions WHERE message_id = ?').run(id);
    db.prepare('DELETE FROM room_pins WHERE message_id = ?').run(id);
    db.prepare('DELETE FROM attachments WHERE message_id = ?').run(id);
    db.prepare('UPDATE messages SET reply_to = NULL WHERE reply_to = ?').run(id);
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  });
  wipe();
  for (const f of files) fs.rm(path.join(uploadsDir, f.id), { force: true }, () => {});
}

// Messages deleted before deletes were final are still sitting in the database as empty shells: remove them now.
for (const row of db.prepare('SELECT id FROM messages WHERE deleted_at IS NOT NULL').all() as { id: string }[]) eraseMessage(row.id);

/** A short quoted view of a message, for the reply block and forwards. */
export function messageSummary(id: string) {
  const m = db
    .prepare('SELECT id, user_id, body, deleted_at FROM messages WHERE id = ?')
    .get(id) as { id: string; user_id: string; body: string; deleted_at: number | null } | undefined;
  if (!m) return null;
  return {
    id: m.id,
    userId: m.user_id,
    body: m.deleted_at ? '' : m.body.slice(0, 240),
    deleted: Boolean(m.deleted_at),
  };
}

/** Who has read up to when, so the client can draw delivery ticks. */
export function readsFor(roomId: string) {
  return (
    db
      .prepare('SELECT user_id, last_read_at FROM room_members WHERE room_id = ?')
      .all(roomId) as { user_id: string; last_read_at: number }[]
  ).map((r) => ({ userId: r.user_id, lastReadAt: r.last_read_at }));
}

/** Pinned message ids for a room, most recently pinned first. */
export function pinIdsFor(roomId: string): string[] {
  return (
    db
      .prepare('SELECT message_id FROM room_pins WHERE room_id = ? ORDER BY created_at DESC')
      .all(roomId) as { message_id: string }[]
  ).map((r) => r.message_id);
}

export function serializeMessage(m: MessageRow) {
  return {
    id: m.id,
    roomId: m.room_id,
    userId: m.user_id,
    body: m.deleted_at ? '' : m.body,
    createdAt: m.created_at,
    editedAt: m.edited_at,
    deletedAt: m.deleted_at,
    replyTo: m.reply_to ? messageSummary(m.reply_to) : null,
    forwarded: Boolean(m.forwarded),
    attachments: attachmentsFor(m.id),
    reactions: reactionsFor(m.id),
  };
}
