import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { currentUser, createSession, hashPassword } from './auth.js';
import { ConfigError, SETTINGS, backupStorageOn, cfg, describeConfig, registrationOpen, sourceOf, updateConfig } from './config.js';
import { db, now, type UserRow } from './db.js';
import { deleteGroup, groupDetail, listGroups, openGroupCount, parseReport, pruneReports, setResolved, storeReport } from './crashReports.js';
import { env } from './env.js';
import { pushEnabled } from './push.js';
import { FailureLimiter } from './ratelimit.js';
import { friendCodeOf, USERNAME_RULE, validUsername } from './social.js';
import { listBackups, usedBytes, validBackupName } from './serverBackups.js';
import { isTotpOn } from './totp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Bumped when something a client depends on changes in a way it must notice. */
export const API_VERSION = 1;
export const SOFTWARE = 'hearth-server';
export const VERSION: string = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

db.exec(`
CREATE TABLE IF NOT EXISTS admin_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  who     TEXT NOT NULL,
  action  TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT ''
);
`);

const MB = 1024 * 1024;
const setupByIp = new FailureLimiter(10, 15 * 60_000);
/** Crash reports per address: a crash loop on one phone must not fill the database. */
const crashByIp = new FailureLimiter(30, 60 * 60_000);

function audit(who: UserRow | string, action: string, detail = ''): void {
  db.prepare('INSERT INTO admin_log (at, who, action, detail) VALUES (?, ?, ?, ?)').run(now(), typeof who === 'string' ? who : who.username, action, detail.slice(0, 300));
}

/** An admin request must come from the page this server serves, not from another site that happens to hold the cookie. */
function sameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply): UserRow | null {
  const me = currentUser(req);
  if (!me) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  if (!me.is_admin) {
    reply.code(403).send({ error: 'this needs an administrator' });
    return null;
  }
  if (req.method !== 'GET' && !sameOrigin(req)) {
    reply.code(403).send({ error: 'cross-site request refused' });
    return null;
  }
  return me;
}

function dirSize(dir: string, depth = 0): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += depth < 6 ? dirSize(p, depth + 1) : 0;
    else {
      try {
        total += fs.statSync(p).size;
      } catch {
        /* removed while counting */
      }
    }
  }
  return total;
}

let sizeCache: { at: number; value: { uploads: number; backups: number; database: number } } | null = null;
function sizes() {
  if (sizeCache && Date.now() - sizeCache.at < 60_000) return sizeCache.value;
  const database = ['hearth.db', 'hearth.db-wal', 'hearth.db-shm'].reduce((n, f) => {
    try {
      return n + fs.statSync(path.join(env.DATA_DIR, f)).size;
    } catch {
      return n;
    }
  }, 0);
  const value = { uploads: dirSize(path.join(env.DATA_DIR, 'uploads')), backups: dirSize(path.join(env.DATA_DIR, 'backups')), database };
  sizeCache = { at: Date.now(), value };
  return value;
}

const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
const livekitConfigured = (): boolean => cfg('livekitSecret') !== 'devsecret' && cfg('livekitSecret') !== '';

async function livekitReachable(): Promise<boolean> {
  try {
    const ctl = AbortSignal.timeout(2500);
    const res = await fetch(cfg('livekitInternalUrl'), { signal: ctl });
    return res.status > 0;
  } catch {
    return false;
  }
}

const adminCount = (): number => count('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0');

function newPassword(): string {
  // Easy to read out loud: no look-alike characters.
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(16);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out.match(/.{1,4}/g)!.join('-');
}

const colorFor = (seed: string): string => {
  const palette = ['#7c6cff', '#ff6bb5', '#45c4a0', '#ffa94d', '#4dabf7', '#f06595', '#94d82d'];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length]!;
};

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

/** Remember every route as it is added, so the panel and the API docs can list what clients may call. */
export function collectRoutes(app: FastifyInstance): Array<{ method: string; url: string }> {
  const routes: Array<{ method: string; url: string }> = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) if (m !== 'HEAD' && m !== 'OPTIONS') routes.push({ method: m, url: route.url });
  });
  return routes;
}

export interface AdminDeps {
  routes: Array<{ method: string; url: string }>;
}

export function registerAdmin(app: FastifyInstance, deps: AdminDeps): void {
  // ---- what any client may ask before anyone is signed in -------------------------------------------------------
  app.get('/api/server/info', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return {
      software: SOFTWARE,
      version: VERSION,
      apiVersion: API_VERSION,
      name: cfg('serverName'),
      motd: cfg('motd'),
      registration: registrationOpen() ? 'open' : 'invite',
      houseKey: cfg('registrationKey').length >= 8,
      setupNeeded: count('SELECT COUNT(*) AS n FROM users') === 0,
      features: { calls: livekitConfigured(), push: pushEnabled(), backups: backupStorageOn(), browser: cfg('browser') !== 'off', twoStep: true, friends: true, crashReports: cfg('crashReports') !== 'off' },
      limits: { backupQuotaMb: Number(cfg('backupQuotaMb')), backupMaxFileMb: Number(cfg('backupMaxFileMb')) },
    };
  });

  // ---- first run: make the first account, which is the administrator --------------------------------------------
  app.post('/api/admin/setup', async (req, reply) => {
    if (count('SELECT COUNT(*) AS n FROM users') > 0) return reply.code(409).send({ error: 'this server is already set up' });
    const blocked = setupByIp.blockedFor(req.ip);
    if (blocked) return reply.code(429).header('retry-after', String(blocked)).send({ error: 'too many tries, wait a bit' });
    if (!sameOrigin(req)) return reply.code(403).send({ error: 'cross-site request refused' });
    const { username, password, displayName } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof username !== 'string' || typeof password !== 'string' || password.length < 8) {
      setupByIp.fail(req.ip);
      return reply.code(400).send({ error: 'a username and an 8+ character password are required' });
    }
    const name = username.trim();
    if (!validUsername(name)) return reply.code(400).send({ error: `a username is ${USERNAME_RULE}` });
    const id = nanoid();
    db.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, avatar_color, status, status_message, created_at, is_admin)
       VALUES (?, ?, ?, ?, ?, 'online', '', ?, 1)`,
    ).run(id, name, typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 60) : name, hashPassword(password), colorFor(id), now());
    friendCodeOf(id);
    audit(name, 'setup', 'created the first administrator');
    createSession(id, reply);
    return { ok: true };
  });

  // ---- overview --------------------------------------------------------------------------------------------------
  app.get('/api/admin/status', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const s = sizes();
    const lk = await livekitReachable();
    return {
      software: SOFTWARE,
      version: VERSION,
      apiVersion: API_VERSION,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / MB),
      dataDir: env.DATA_DIR,
      supervised: process.env.HEARTH_SUPERVISED === '1',
      counts: {
        users: count('SELECT COUNT(*) AS n FROM users'),
        admins: count('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1'),
        disabled: count('SELECT COUNT(*) AS n FROM users WHERE disabled = 1'),
        signedIn: count(`SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE expires_at > ${now()}`),
        rooms: count('SELECT COUNT(*) AS n FROM rooms'),
        messages: count('SELECT COUNT(*) AS n FROM messages'),
        attachments: count('SELECT COUNT(*) AS n FROM attachments'),
        openInvites: count('SELECT COUNT(*) AS n FROM invites WHERE used_by IS NULL'),
        openCrashes: openGroupCount(),
      },
      storageBytes: s,
      calls: { configured: livekitConfigured(), reachable: lk, url: sourceOf('livekitUrl') !== 'default' ? cfg('livekitUrl') : '(from the address clients use)' },
      push: { configured: pushEnabled() },
      secrets: { sessionSecretChanged: env.SESSION_SECRET !== 'dev-session-secret-change-me' },
    };
  });

  // ---- settings --------------------------------------------------------------------------------------------------
  app.get('/api/admin/config', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { settings: describeConfig() };
  });

  app.put('/api/admin/config', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const raw = ((req.body ?? {}) as { changes?: unknown }).changes;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reply.code(400).send({ error: 'send {"changes": {key: value}}' });
    const changes: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === null || typeof v === 'string') changes[k] = v;
      else return reply.code(400).send({ error: `${k} must be text or null` });
    }
    try {
      const result = updateConfig(changes);
      for (const key of result.changed) {
        const def = SETTINGS.find((s) => s.key === key)!;
        audit(me, 'setting', def.type === 'secret' ? `${key} changed` : `${key} = ${cfg(key)}`);
      }
      return { ...result, settings: describeConfig() };
    } catch (e) {
      if (e instanceof ConfigError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  // ---- people ----------------------------------------------------------------------------------------------------
  const userView = (u: UserRow & { last_in: number | null; messages: number }) => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarColor: u.avatar_color,
    twoStep: isTotpOn(u.id),
    createdAt: u.created_at,
    isAdmin: Boolean(u.is_admin),
    disabled: Boolean(u.disabled),
    lastSignIn: u.last_in,
    messages: u.messages,
    backupBytes: usedBytes(path.join(env.DATA_DIR, 'backups', u.id.replace(/[^A-Za-z0-9_-]/g, '_'))),
  });

  app.get('/api/admin/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const rows = db
      .prepare(
        `SELECT u.*, (SELECT MAX(created_at) FROM sessions s WHERE s.user_id = u.id) AS last_in,
                (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id) AS messages
         FROM users u ORDER BY u.created_at ASC`,
      )
      .all() as Array<UserRow & { last_in: number | null; messages: number }>;
    return { users: rows.map(userView) };
  });

  const target = (req: FastifyRequest, reply: FastifyReply): UserRow | null => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get((req.params as { id: string }).id) as UserRow | undefined;
    if (!u) {
      reply.code(404).send({ error: 'no such person' });
      return null;
    }
    return u;
  };

  const endSessions = (userId: string): void => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM remember_tokens WHERE user_id = ?').run(userId);
  };

  app.patch('/api/admin/users/:id', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const u = target(req, reply);
    if (!u) return;
    const body = (req.body ?? {}) as { disabled?: unknown; isAdmin?: unknown };
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== 'boolean') return reply.code(400).send({ error: 'disabled must be true or false' });
      if (body.disabled && u.id === me.id) return reply.code(409).send({ error: 'you cannot switch off your own account' });
      if (body.disabled && u.is_admin && adminCount() <= 1) return reply.code(409).send({ error: 'that is the only administrator' });
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, u.id);
      if (body.disabled) endSessions(u.id);
      audit(me, body.disabled ? 'disable' : 'enable', u.username);
    }
    if (body.isAdmin !== undefined) {
      if (typeof body.isAdmin !== 'boolean') return reply.code(400).send({ error: 'isAdmin must be true or false' });
      if (!body.isAdmin && u.is_admin && adminCount() <= 1) return reply.code(409).send({ error: 'there must be at least one administrator' });
      if (body.isAdmin && u.disabled) return reply.code(409).send({ error: 'switch the account on first' });
      db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(body.isAdmin ? 1 : 0, u.id);
      audit(me, body.isAdmin ? 'make-admin' : 'remove-admin', u.username);
    }
    return { ok: true };
  });

  app.post('/api/admin/users/:id/reset-password', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const u = target(req, reply);
    if (!u) return;
    const temporary = newPassword();
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(temporary), u.id);
    endSessions(u.id);
    audit(me, 'reset-password', u.username);
    reply.header('cache-control', 'no-store');
    return { password: temporary };
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const u = target(req, reply);
    if (!u) return;
    if (u.id === me.id) return reply.code(409).send({ error: 'you cannot remove your own account' });
    if (u.is_admin && adminCount() <= 1) return reply.code(409).send({ error: 'that is the only administrator' });
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    fs.rmSync(path.join(env.DATA_DIR, 'backups', u.id.replace(/[^A-Za-z0-9_-]/g, '_')), { recursive: true, force: true });
    audit(me, 'remove-user', u.username);
    return { ok: true };
  });

  // ---- invites ---------------------------------------------------------------------------------------------------
  app.get('/api/admin/invites', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const invites = db
      .prepare(
        `SELECT i.code, i.created_at AS createdAt, c.username AS createdBy, u.username AS usedBy, i.used_at AS usedAt
         FROM invites i JOIN users c ON c.id = i.created_by LEFT JOIN users u ON u.id = i.used_by
         ORDER BY i.created_at DESC LIMIT 200`,
      )
      .all();
    return { invites };
  });

  app.post('/api/admin/invites', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const code = nanoid(10);
    db.prepare('INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)').run(code, me.id, now());
    audit(me, 'invite', 'created an invite code');
    return { code };
  });

  app.delete('/api/admin/invites/:code', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const r = db.prepare('DELETE FROM invites WHERE code = ? AND used_by IS NULL').run((req.params as { code: string }).code);
    if (!r.changes) return reply.code(404).send({ error: 'no such unused invite' });
    audit(me, 'revoke-invite', '');
    return { ok: true };
  });

  // ---- backups kept for people -----------------------------------------------------------------------------------
  app.get('/api/admin/backups', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const users = db.prepare('SELECT id, username FROM users ORDER BY username').all() as Array<{ id: string; username: string }>;
    const out = users
      .map((u) => {
        const files = listBackups(path.join(env.DATA_DIR, 'backups', u.id.replace(/[^A-Za-z0-9_-]/g, '_')));
        return { userId: u.id, username: u.username, files, bytes: files.reduce((n, f) => n + f.size, 0) };
      })
      .filter((u) => u.files.length > 0);
    return { backups: out, quotaMb: Number(cfg('backupQuotaMb')) };
  });

  app.delete('/api/admin/backups/:userId/:name', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const { userId, name } = req.params as { userId: string; name: string };
    if (!validBackupName(name)) return reply.code(400).send({ error: 'that is not a backup name' });
    const u = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
    if (!u) return reply.code(404).send({ error: 'no such person' });
    const file = path.join(env.DATA_DIR, 'backups', userId.replace(/[^A-Za-z0-9_-]/g, '_'), name);
    try {
      fs.unlinkSync(file);
    } catch {
      return reply.code(404).send({ error: 'no such backup' });
    }
    sizeCache = null;
    audit(me, 'delete-backup', `${u.username}/${name}`);
    return { ok: true };
  });

  // ---- crash reports ---------------------------------------------------------------------------------------------
  // Any client may send one, signed in or not (a crash can happen before sign-in). Rate limited per address.
  app.post('/api/crash-reports', async (req, reply) => {
    if (cfg('crashReports') === 'off') return reply.code(403).send({ error: 'this server does not collect crash reports' });
    const wait = crashByIp.blockedFor(req.ip);
    if (wait) {
      reply.header('retry-after', String(wait));
      return reply.code(429).send({ error: 'too many crash reports from this address; try again later' });
    }
    const report = parseReport(req.body);
    if (typeof report === 'string') return reply.code(400).send({ error: report });
    crashByIp.fail(req.ip);
    const stored = storeReport(report, currentUser(req)?.id ?? null);
    return { ok: true, id: stored.id };
  });

  app.get('/api/admin/crashes', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const q = req.query as { status?: string; source?: string };
    const status = q.status === 'resolved' || q.status === 'all' ? q.status : 'open';
    const groups = listGroups({ status, source: q.source || undefined });
    return { groups, open: openGroupCount(), keepDays: Number(cfg('crashKeepDays')), collecting: cfg('crashReports') !== 'off' };
  });

  app.get('/api/admin/crashes/:signature', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const found = groupDetail((req.params as { signature: string }).signature);
    if (!found) return reply.code(404).send({ error: 'no such crash' });
    return found;
  });

  app.post('/api/admin/crashes/:signature/resolve', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const body = (req.body ?? {}) as { resolved?: unknown; note?: unknown };
    const signature = (req.params as { signature: string }).signature;
    if (!setResolved(signature, body.resolved !== false, typeof body.note === 'string' ? body.note : '')) return reply.code(404).send({ error: 'no such crash' });
    audit(me, body.resolved === false ? 'reopen-crash' : 'resolve-crash', signature);
    return { ok: true };
  });

  app.delete('/api/admin/crashes/:signature', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const signature = (req.params as { signature: string }).signature;
    if (!deleteGroup(signature)) return reply.code(404).send({ error: 'no such crash' });
    audit(me, 'delete-crash', signature);
    return { ok: true };
  });

  const prune = () => {
    try {
      pruneReports(Number(cfg('crashKeepDays')));
    } catch {
      /* the next hour tries again */
    }
  };
  prune();
  setInterval(prune, 3_600_000).unref();

  // ---- log, route list, restart ----------------------------------------------------------------------------------
  app.get('/api/admin/log', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { log: db.prepare('SELECT at, who, action, detail FROM admin_log ORDER BY id DESC LIMIT 100').all() };
  });

  app.get('/api/admin/routes', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const routes = [...deps.routes].filter((r) => r.url.startsWith('/api') || r.url === '/ws').sort((a, b) => (a.url === b.url ? a.method.localeCompare(b.method) : a.url.localeCompare(b.url)));
    return { routes };
  });

  app.post('/api/admin/restart', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    if (process.env.HEARTH_SUPERVISED !== '1') return reply.code(409).send({ error: 'this server is not run by something that restarts it, so restart it yourself' });
    audit(me, 'restart', '');
    setTimeout(() => process.exit(0), 300).unref();
    return { ok: true };
  });

  // ---- the panel itself: plain files, no build step ---------------------------------------------------------------
  const adminDir = path.join(__dirname, 'admin');
  const serve = (reply: FastifyReply, name: string) => {
    const file = path.join(adminDir, name);
    if (!file.startsWith(adminDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return reply.code(404).send({ error: 'not found' });
    return reply
      .header('content-security-policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', path.extname(file) === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache')
      .type(MIME[path.extname(file)] ?? 'application/octet-stream')
      .send(fs.createReadStream(file));
  };
  app.get('/admin', async (_req, reply) => serve(reply, 'index.html'));
  app.get('/admin/', async (_req, reply) => serve(reply, 'index.html'));
  app.get('/admin/:file', async (req, reply) => serve(reply, (req.params as { file: string }).file));
}
