import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { cfg, updateConfig } from './config.js';
import { db, now, type UserRow } from './db.js';

/**
 * What the mirror code needs from the server around it, kept apart so the same mirror code runs on a server without a settings layer or an
 * admin panel (the main server's own copy of this file is a smaller one).
 */

const SHARED = ['serverName', 'motd', 'registration', 'registrationKey', 'backupStorage', 'backupQuotaMb', 'backupMaxFileMb', 'browser', 'crashReports', 'crashKeepDays'];

/** Settings that belong to the whole server, copied to mirrors. */
export function sharedSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SHARED) out[k] = cfg(k);
  return out;
}

export function applySharedSettings(settings: Record<string, string> | undefined): void {
  if (!settings) return;
  const changes: Record<string, string> = {};
  for (const k of SHARED) if (typeof settings[k] === 'string' && settings[k] !== cfg(k)) changes[k] = settings[k]!;
  if (Object.keys(changes).length > 0) updateConfig(changes);
}

export const serverName = (): string => cfg('serverName');

/** Who may link, unlink and promote servers. */
export const isClusterAdmin = (user: UserRow): boolean => !!user.is_admin;

/** After a copy from another server: make sure somebody can still administer this one (the other server may not have the same admin flags). */
export function afterCopy(d: Database.Database = db): void {
  d.exec('UPDATE users SET is_admin = 1 WHERE id = (SELECT id FROM users ORDER BY created_at LIMIT 1) AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)');
}

export function logLine(action: string, detail: string): void {
  db.prepare('INSERT INTO admin_log (at, who, action, detail) VALUES (?, ?, ?, ?)').run(now(), 'servers', action, detail.slice(0, 300));
}

/** The server information route lives in the admin module here, so the mirror code adds nothing. */
export const serveInfo = false;
export function infoBody(): Record<string, unknown> {
  return {};
}
export function registerHostRoutes(_app: FastifyInstance): void {
  /* nothing: the admin module has the routes */
}
