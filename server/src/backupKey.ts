import { createHash, randomBytes } from 'node:crypto';
import { db, now } from './db.js';

/**
 * The key that seals this person's Ember backups. It is made once, kept with the account and handed only to the signed-in owner, so a phone (or the
 * desktop backup reader) needs no password of its own: signing in is the proof. Whoever is not that person cannot ask for it.
 */
db.exec(`CREATE TABLE IF NOT EXISTS user_backup_key (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);

export interface BackupKey {
  /** 32 random bytes, base64. */
  key: string;
  /** A short fingerprint (not secret) so a backup can say which key sealed it. */
  id: string;
}

export function fingerprint(keyBase64: string): string {
  return createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('hex').slice(0, 8);
}

export function makeBackupKey(): BackupKey {
  const key = randomBytes(32).toString('base64');
  return { key, id: fingerprint(key) };
}

export function backupKeyFor(userId: string): BackupKey {
  const existing = db.prepare('SELECT key FROM user_backup_key WHERE user_id = ?').get(userId) as { key: string } | undefined;
  if (existing) return { key: existing.key, id: fingerprint(existing.key) };
  const made = makeBackupKey();
  // Two first requests at once: the first insert wins, and both read the same row.
  db.prepare('INSERT OR IGNORE INTO user_backup_key (user_id, key, created_at) VALUES (?, ?, ?)').run(userId, made.key, now());
  const row = db.prepare('SELECT key FROM user_backup_key WHERE user_id = ?').get(userId) as { key: string };
  return { key: row.key, id: fingerprint(row.key) };
}
