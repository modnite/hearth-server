import { checkSecondStep, disable as disableTotp, enable as enableTotp, isTotpOn, otpauthUri, startSetup, totpStatus } from './totp.js';
import { browseEnabled, BrowseError, allowBrowse, fetchPage, rewriteHtml, textOf } from './browseProxy.js';
import { backupKeyFor } from './backupKey.js';
import { allowNudge } from './nudgeLimit.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import {
  createRememberToken,
  createSession,
  destroySession,
  forgetRememberToken,
  hashPassword,
  redeemRememberToken,
  requireUser,
  userFromToken,
  verifyPassword,
  SESSION_COOKIE,
} from './auth.js';
import {
  eraseMessage,
  attachmentsFor,
  db,
  isMember,
  memberIds,
  messageSummary,
  now,
  pinIdsFor,
  publicUser,
  readsFor,
  serializeMessage,
  uploadsDir,
  type MessageRow,
  type UserRow,
} from './db.js';
import { env } from './env.js';
import { media, mediaRoomName } from './media.js';
import { fetchPreview } from './preview.js';
import { cfg, registrationOpen, sourceOf } from './config.js';
import { FailureLimiter } from './ratelimit.js';
import { pushToUser } from './push.js';
import { hub } from './realtime.js';
import { registerServerBackups } from './serverBackups.js';
import { isArchived, setArchived, blockedEitherWay, dmBlocked, findUser, friendCodeOf, registerSocial, USERNAME_RULE, usernameFree, validUsername } from './social.js';
import { acceptContact, canSee, connectViaInvite, contactIds, pendingFor, removeContact, requestContact, visibleUserIds } from './contacts.js';
import { registerNativeNotificationRoutes } from './nativeNotifications.js';
import { addMembers, MemberError, passOnGroup, removeMember } from './groupMembers.js';

const MAX_UPLOAD = 200 * 1024 * 1024;

// Brute-force guards: failed logins per IP and per username, failed house-key/invite tries per IP.
const loginByIp = new FailureLimiter(30, 15 * 60_000);
const loginByUser = new FailureLimiter(8, 15 * 60_000);
const registerByIp = new FailureLimiter(10, 15 * 60_000);
/** REGISTRATION=open lets anyone create an account without an invite code or house key. Off by default: invite codes only. */
/** An open door still counts: at most five new accounts from one address in an hour. */
const registered = new Map<string, number[]>();
function allowNewAccount(ip: string, nowMs = Date.now()): boolean {
  const recent = (registered.get(ip) ?? []).filter((t) => nowMs - t < 3_600_000);
  if (recent.length >= 5) { registered.set(ip, recent); return false; }
  registered.set(ip, [...recent, nowMs]);
  return true;
}

// Types a browser would run as a page if served inline from our origin.
import { contentDisposition, parseRange } from './attachmentHttp.js';

const ACTIVE_MIME = /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml|text\/javascript|application\/javascript|text\/css)/i;

// --- the assistant's voice: Microsoft Sam via the OpenSAPI4 service ----------
// Sam is deterministic, so a WAV for a given text is cached: memory first,
// then disk under DATA_DIR (balloons repeat a lot).
const TTS_TEXT_MAX = 1200;
const TTS_MEMORY_MAX = 120;
const ttsCacheDir = path.join(env.DATA_DIR, 'tts-cache');
fs.mkdirSync(ttsCacheDir, { recursive: true });
const ttsMemory = new Map<string, Buffer>();
function rememberTts(key: string, data: Buffer): void {
  ttsMemory.set(key, data);
  while (ttsMemory.size > TTS_MEMORY_MAX) {
    const oldest = ttsMemory.keys().next().value;
    if (oldest === undefined) break;
    ttsMemory.delete(oldest);
  }
}

function userById(id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

function messageById(id: string): MessageRow | undefined {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
}

function fullMessage(m: MessageRow) {
  const user = userById(m.user_id);
  return { ...serializeMessage(m), user: user ? publicUser(user) : null };
}

function fieldValue(fields: unknown, name: string): string {
  const entry = (fields as Record<string, unknown> | undefined)?.[name];
  if (!entry || Array.isArray(entry)) return '';
  const value = (entry as { value?: unknown }).value;
  return value === undefined ? '' : String(value);
}

function roomView(roomId: string, meId: string) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) as
    | {
        id: string;
        kind: string;
        name: string;
        topic: string;
        avatar: string;
        encrypted: number;
        created_by: string | null;
        created_at: number;
      }
    | undefined;
  if (!room) return null;
  const members = memberIds(roomId)
    .map((id) => userById(id))
    .filter(Boolean)
    .map((u) => {
      const v = publicUser(u as UserRow);
      // An invisible member looks offline to everyone but themselves (as in /api/users and presence).
      if (v.id !== meId && v.status === 'invisible') v.status = 'offline';
      return v;
    });
  const last = db
    .prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(roomId) as MessageRow | undefined;
  const readRow = db
    .prepare('SELECT last_read_at FROM room_members WHERE room_id = ? AND user_id = ?')
    .get(roomId, meId) as { last_read_at: number } | undefined;
  const lastRead = readRow?.last_read_at ?? 0;
  const unread = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
         WHERE room_id = ? AND created_at > ? AND user_id != ? AND deleted_at IS NULL`,
      )
      .get(roomId, lastRead, meId) as { n: number }
  ).n;

  return {
    id: room.id,
    kind: room.kind,
    name: room.name,
    topic: room.topic,
    avatar: room.avatar ? `/api/room-avatars/${room.avatar}` : null,
    encrypted: Boolean(room.encrypted),
    createdAt: room.created_at,
    // Who made the group: the one who may remove people. Null for a group from before this was recorded.
    createdBy: room.created_by ?? null,
    members,
    lastMessage: last ? fullMessage(last) : null,
    unread,
    archived: isArchived(roomId, meId),
    // Delivery ticks and the pinned banner, so a fresh load matches live state.
    reads: readsFor(roomId),
    pinned: pinIdsFor(roomId)
      .map((id) => messageById(id))
      .filter((m): m is MessageRow => Boolean(m))
      .map((m) => fullMessage(m)),
  };
}

function notifyNewMessage(roomId: string, message: MessageRow): void {
  const payload = { t: 'message', message: fullMessage(message) };
  hub.toRoom(roomId, payload);

  const room = db.prepare('SELECT encrypted, kind, name FROM rooms WHERE id = ?').get(roomId) as
    | { encrypted: number; kind: string; name: string }
    | undefined;
  const sender = userById(message.user_id);
  const senderName = sender ? sender.display_name : 'Hearth';
  // A group says where it came from; a DM is just the person.
  const title = room?.kind === 'group' && room.name ? `${senderName} in ${room.name}` : senderName;
  // The server cannot read encrypted rooms, so push stays deliberately vague.
  const preview = room?.encrypted
    ? 'sent a message'
    : message.body
      ? message.body.slice(0, 140)
      : attachmentsFor(message.id).length
        ? 'sent an attachment'
        : 'sent a message';
  for (const member of memberIds(roomId)) {
    if (member === message.user_id) continue;
    // An archived chat is quiet: no push, but its unread count still grows.
    if (isArchived(roomId, member)) continue;
    {
      // How many are waiting for them in this room, so a busy chat reads as
      // "3 new" on the one notification that replaces the last.
      const waiting = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM messages m
               JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = ?
              WHERE m.room_id = ? AND m.user_id != ? AND m.created_at > rm.last_read_at`,
          )
          .get(member, roomId, member) as { n: number }
      ).n;
      void pushToUser(member, {
        title,
        body: waiting > 1 ? `${preview} (+${waiting - 1} more)` : preview,
        roomId,
        url: `/?room=${roomId}`,
        tag: roomId,
        count: Math.max(1, waiting),
      }, { web: !hub.isActive(member) });
    }
  }
}

/** Constant-time string compare, so the house key can't be probed by timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function registerRoutes(app: FastifyInstance): void {
  registerNativeNotificationRoutes(app, (roomId, startedAt) => hub.isRinging(roomId, startedAt));
  // ---------------------------------------------------------------- auth
  app.post('/api/auth/register', async (req, reply) => {
    const blocked = registerByIp.blockedFor(req.ip);
    if (blocked) return reply.code(429).header('retry-after', String(blocked)).send({ error: 'too many tries, wait a bit' });
    const { invite, username, displayName, password } = (req.body ?? {}) as Record<string, string>;
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || password.length < 8) {
      return reply.code(400).send({ error: 'username and an 8+ character password are required' });
    }
    const inv = db.prepare('SELECT * FROM invites WHERE code = ? AND used_by IS NULL').get(invite) as
      | { code: string; created_by: string }
      | undefined;
    // No invite code needed when the shared house key is configured and given.
    const houseKey = cfg('registrationKey');
    const viaHouseKey = houseKey.length >= 8 && safeEqual(invite ?? '', houseKey);
    if (!inv && !viaHouseKey) {
      // Open registration: no code needed (a wrong code is ignored, not an error), within the hourly limit.
      if (!registrationOpen()) {
        registerByIp.fail(req.ip);
        return reply.code(400).send({ error: 'that invite code or house key is not valid' });
      }
      if (!allowNewAccount(req.ip)) return reply.code(429).send({ error: 'too many new accounts from here, try again later' });
    }

    if (!validUsername(username.trim())) return reply.code(400).send({ error: `a username is ${USERNAME_RULE}` });
    if (!usernameFree(username.trim())) return reply.code(409).send({ error: 'that username is taken' });

    const id = nanoid();
    db.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, avatar_color, status, status_message, created_at)
       VALUES (?, ?, ?, ?, ?, 'online', '', ?)`,
    ).run(id, username, displayName || username, hashPassword(password), colorFor(id), now());
    friendCodeOf(id);
    if (inv) {
      db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?').run(id, now(), invite);
      // Whoever invited you is your first contact.
      connectViaInvite(inv.created_by, id);
    }

    createSession(id, reply);
    return { user: publicUser(userById(id)!) };
  });

  // The built-in browser: a page fetched for the signed-in person and handed to a sandboxed frame (see browseProxy.ts). GET for links, POST for forms.
  const serveBrowse = async (req: FastifyRequest, reply: FastifyReply, raw: string, post?: Array<[string, string]>) => {
    const me = requireUser(req, reply);
    if (!me) return;
    if (!browseEnabled()) return reply.code(503).send({ error: 'the browser is switched off on this server' });
    if (!allowBrowse(me.id)) return reply.code(429).send({ error: 'slow down a little' });
    try {
      const page = await fetchPage(raw, { post, language: String(req.headers['accept-language'] ?? '') });
      const type = page.contentType.toLowerCase();
      reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer');
      if (type.startsWith('text/html') || type.includes('xhtml')) {
        return reply
          .header('content-security-policy', 'sandbox allow-scripts allow-forms allow-popups allow-modals')
          .type('text/html; charset=utf-8')
          .send(rewriteHtml(textOf(page), page.url.href));
      }
      if (/^(image|audio|video)\//.test(type) || type.startsWith('application/pdf') || type.startsWith('text/plain')) {
        return reply.header('content-security-policy', 'sandbox').type(page.contentType).send(page.body);
      }
      return reply.code(415).type('text/html; charset=utf-8').send('<p style="font:14px sans-serif;padding:20px">This kind of file cannot be shown here.</p>');
    } catch (e) {
      const status = e instanceof BrowseError ? e.status : 502;
      const message = e instanceof BrowseError ? e.message : 'The site could not be reached.';
      const esc = message.replace(/[<>&]/g, '');
      return reply.code(status).header('content-security-policy', 'sandbox').type('text/html; charset=utf-8').send(`<p style="font:14px sans-serif;padding:20px">${esc}</p>`);
    }
  };
  app.get('/api/browse', async (req, reply) => serveBrowse(req, reply, String((req.query as { url?: string }).url ?? '')));
  app.post('/api/browse', async (req, reply) => {
    const body = (req.body ?? {}) as { url?: unknown; fields?: unknown };
    const fields = Array.isArray(body.fields)
      ? (body.fields as unknown[]).filter((p): p is [string, string] => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string').slice(0, 200)
      : [];
    return serveBrowse(req, reply, String(body.url ?? ''), fields);
  });

  // The key that seals this person's backups, for the signed-in owner only (see backupKey.ts). Never cached.
  app.get('/api/backup/key', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    reply.header('cache-control', 'no-store');
    return backupKeyFor(me.id);
  });

  // What the sign-in screen needs to know before anyone is signed in.
  app.get('/api/auth/config', async () => ({ registration: registrationOpen() ? 'open' : 'invite', twoStep: true, name: cfg('serverName'), motd: cfg('motd') }));

  // Two-step sign-in with an authenticator app, from the person's own account (see totp.ts).
  app.get('/api/auth/2fa', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    return totpStatus(me.id);
  });
  app.post('/api/auth/2fa/setup', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    if (isTotpOn(me.id)) return reply.code(409).send({ error: 'two-step sign-in is already on' });
    const secret = startSetup(me.id);
    return { secret, uri: otpauthUri(`${me.username}@${env.HEARTH_DOMAIN}`, secret) };
  });
  app.post('/api/auth/2fa/enable', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const code = String(((req.body ?? {}) as Record<string, unknown>).code ?? '');
    const recovery = enableTotp(me.id, code);
    if (!recovery) return reply.code(400).send({ error: 'that code is not right, or the time on your phone is off' });
    return { recovery };
  });
  app.post('/api/auth/2fa/disable', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const { password, code } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof password !== 'string' || !verifyPassword(password, me.password_hash)) return reply.code(403).send({ error: 'wrong password' });
    if (isTotpOn(me.id) && !checkSecondStep(me.id, String(code ?? ''))) return reply.code(403).send({ error: 'that two-step code is not right' });
    disableTotp(me.id);
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof username !== 'string' || typeof password !== 'string') {
      return reply.code(400).send({ error: 'username and password are required' });
    }
    const userKey = username.toLowerCase();
    const blocked = Math.max(loginByIp.blockedFor(req.ip), loginByUser.blockedFor(userKey));
    if (blocked) return reply.code(429).header('retry-after', String(blocked)).send({ error: 'too many tries, wait a bit' });
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    if (!user || !verifyPassword(password, user.password_hash)) {
      loginByIp.fail(req.ip);
      loginByUser.fail(userKey);
      return reply.code(401).send({ error: 'wrong username or password' });
    }
    if (user.disabled) return reply.code(403).send({ error: 'this account has been switched off by the person who runs this server' });
    if (isTotpOn(user.id)) {
      const given = (req.body as Record<string, unknown>).code;
      if (typeof given !== 'string' || !given.trim()) return reply.code(401).send({ error: 'two-step code needed', needs2fa: true });
      if (!checkSecondStep(user.id, given)) {
        loginByIp.fail(req.ip);
        loginByUser.fail(userKey);
        return reply.code(401).send({ error: 'that two-step code is not right', needs2fa: true });
      }
    }
    loginByUser.reset(userKey);
    createSession(user.id, reply);
    return { user: publicUser(user) };
  });

  // ---- Windows client updates ------------------------------------------------------------------------------
  // The native Windows client checks here for a newer build. The files live in DATA_DIR/client-win/ (published by
  // client-win/tools/publish-update.mjs): latest.json {version, file, sha256, size, notes, signature} and the zip it
  // names. Only signed-in people can read either: the zip holds assets that must not be public, and the update is
  // signed on the publisher's machine, so the client verifies it no matter who served it.
  const clientDir = path.join(env.DATA_DIR, 'client-win');
  app.get('/api/client/win/latest', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(clientDir, 'latest.json'), 'utf8')) as Record<string, unknown>;
      return { ...manifest, url: '/api/client/win/download' };
    } catch {
      return reply.code(404).send({ error: 'no update has been published' });
    }
  });

  app.get('/api/client/win/download', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(clientDir, 'latest.json'), 'utf8')) as { file?: unknown };
      const name = typeof manifest.file === 'string' ? path.basename(manifest.file) : '';
      if (!/^[\w.-]+\.zip$/.test(name)) return reply.code(404).send({ error: 'no update has been published' });
      const file = path.join(clientDir, name);
      const stat = fs.statSync(file);
      return reply
        .header('content-type', 'application/zip')
        .header('content-length', String(stat.size))
        .header('cache-control', 'private, no-store')
        .send(fs.createReadStream(file));
    } catch {
      return reply.code(404).send({ error: 'no update has been published' });
    }
  });

  // "Remember me on this device": the signed-in client asks for a secret it keeps (the tile on the login screen),
  // and trades it for a session without typing the password. Single use: every trade returns a new secret.
  app.post('/api/auth/remember', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { label } = (req.body ?? {}) as Record<string, unknown>;
    return createRememberToken(user.id, typeof label === 'string' ? label : '');
  });

  app.post('/api/auth/remember-login', async (req, reply) => {
    const { id, token } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof id !== 'string' || typeof token !== 'string' || !id || !token) {
      return reply.code(400).send({ error: 'id and token are required' });
    }
    const blocked = loginByIp.blockedFor(req.ip);
    if (blocked) return reply.code(429).header('retry-after', String(blocked)).send({ error: 'too many tries, wait a bit' });
    const got = redeemRememberToken(id, token);
    if (!got) {
      loginByIp.fail(req.ip);
      return reply.code(401).send({ error: 'this device is no longer remembered, sign in again' });
    }
    const user = userById(got.userId);
    if (!user) return reply.code(401).send({ error: 'this device is no longer remembered, sign in again' });
    createSession(user.id, reply);
    return { user: publicUser(user), token: got.token };
  });

  app.post('/api/auth/forget', async (req, reply) => {
    const { id, token } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof id !== 'string' || !id) return reply.code(400).send({ error: 'id is required' });
    const me = userFromToken(req.cookies?.[SESSION_COOKIE] ?? null);
    forgetRememberToken(id, { token: typeof token === 'string' ? token : undefined, userId: me?.id });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) destroySession(token, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    return { user: publicUser(me), admin: Boolean(me.is_admin) };
  });

  app.patch('/api/auth/me', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const { displayName, statusMessage, avatarColor, wallpaper } = req.body as Record<string, string>;
    // Presets are short ids; uploads are wp_<id>.<ext>. Anything else is ignored.
    const cleanWallpaper =
      wallpaper === undefined
        ? null
        : /^[a-z0-9_-]{0,24}$/i.test(wallpaper) ||
            /^wp_[A-Za-z0-9_-]{8,32}\.(png|jpg|webp)$/.test(wallpaper)
          ? wallpaper
          : null;
    db.prepare(
      'UPDATE users SET display_name = COALESCE(?, display_name), status_message = COALESCE(?, status_message), avatar_color = COALESCE(?, avatar_color), wallpaper = COALESCE(?, wallpaper) WHERE id = ?',
    ).run(displayName ?? null, statusMessage ?? null, avatarColor ?? null, cleanWallpaper, me.id);
    const updated = userById(me.id)!;
    hub.broadcastPresence(me.id);
    return { user: publicUser(updated) };
  });

  // Profile pictures: small images stored beside uploads, served by id.
  const AVATAR_EXT: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  };
  const AVATAR_MIME: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  const MAX_AVATAR = 4 * 1024 * 1024;

  app.post('/api/auth/avatar', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const data = await req.file({ limits: { fileSize: MAX_AVATAR } });
    if (!data) return reply.code(400).send({ error: 'no file' });
    const ext = AVATAR_EXT[data.mimetype ?? ''];
    if (!ext) return reply.code(400).send({ error: 'images only (png, jpg, webp, gif)' });
    const id = `av_${nanoid(16)}${ext}`;
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(path.join(uploadsDir, id));
      data.file.pipe(out);
      data.file.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
    });
    const previous = userById(me.id)?.avatar ?? '';
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(id, me.id);
    if (previous) fs.rm(path.join(uploadsDir, previous), { force: true }, () => {});
    hub.announceUser(me.id);
    return { user: publicUser(userById(me.id)!) };
  });

  app.delete('/api/auth/avatar', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const previous = userById(me.id)?.avatar ?? '';
    db.prepare("UPDATE users SET avatar = '' WHERE id = ?").run(me.id);
    if (previous) fs.rm(path.join(uploadsDir, previous), { force: true }, () => {});
    hub.announceUser(me.id);
    return { user: publicUser(userById(me.id)!) };
  });

  app.get('/api/avatars/:id', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const id = (req.params as { id: string }).id;
    const mime = AVATAR_MIME[path.extname(id)];
    const filePath = path.join(uploadsDir, id);
    if (!/^av_[A-Za-z0-9_-]{8,32}\.(png|jpg|webp|gif)$/.test(id) || !mime || !fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'not found' });
    }
    reply
      .header('content-type', mime)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(fs.createReadStream(filePath));
  });

  const MAX_WALLPAPER = 8 * 1024 * 1024;

  app.post('/api/auth/wallpaper', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const data = await req.file({ limits: { fileSize: MAX_WALLPAPER } });
    if (!data) return reply.code(400).send({ error: 'no file' });
    const ext = AVATAR_EXT[data.mimetype ?? ''];
    if (!ext || ext === '.gif') return reply.code(400).send({ error: 'images only (png, jpg, webp)' });
    const id = `wp_${nanoid(16)}${ext}`;
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(path.join(uploadsDir, id));
      data.file.pipe(out);
      data.file.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
    });
    const previous = userById(me.id)?.wallpaper ?? '';
    db.prepare('UPDATE users SET wallpaper = ? WHERE id = ?').run(id, me.id);
    if (previous.startsWith('wp_')) fs.rm(path.join(uploadsDir, previous), { force: true }, () => {});
    hub.announceUser(me.id);
    return { user: publicUser(userById(me.id)!) };
  });

  app.get('/api/wallpapers/:id', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const id = (req.params as { id: string }).id;
    const mime = AVATAR_MIME[path.extname(id)];
    const filePath = path.join(uploadsDir, id);
    if (
      !/^wp_[A-Za-z0-9_-]{8,32}\.(png|jpg|webp)$/.test(id) ||
      !mime ||
      !fs.existsSync(filePath)
    ) {
      return reply.code(404).send({ error: 'not found' });
    }
    reply
      .header('content-type', mime)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(fs.createReadStream(filePath));
  });

  // ---------------------------------------------------------------- Luna bitmaps
  // Windows XP's Luna window and Start pictures are Microsoft files supplied for private use. They are not in the app image and not public:
  // they live in DATA_DIR/luna and are read only by signed-in people, like the Windows client's update zip. A missing file is a real 404, not
  // the app's own page, so the page can tell the pictures are absent (lib/lunaProbe.ts) and draw the plain look instead.
  const lunaDir = path.join(env.DATA_DIR, 'luna');
  app.get('/luna/*', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const rel = decodeURIComponent((req.params as { '*': string })['*'] ?? '');
    if (!/^[a-z0-9_-]+(\/[a-z0-9_.-]+)*\.webp$/i.test(rel) || rel.includes('..')) return reply.code(404).send({ error: 'not found' });
    const file = path.join(lunaDir, rel);
    if (!file.startsWith(lunaDir + path.sep) || !fs.existsSync(file)) return reply.code(404).send({ error: 'not found' });
    return reply.header('content-type', 'image/webp').header('cache-control', 'private, max-age=86400').send(fs.createReadStream(file));
  });

  // ---------------------------------------------------------------- users
  app.get('/api/users', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    // Only people this user may see: themselves, their contacts and anyone they share a chat with. Not a directory of the server.
    const visible = visibleUserIds(me.id);
    const users = (db.prepare('SELECT * FROM users ORDER BY display_name').all() as UserRow[]).filter((u) => visible.has(u.id));
    return {
      users: users.map((u) => {
        const base = publicUser(u);
        // An invisible user looks offline to everyone but themselves.
        if (u.id !== me.id && base.status === 'invisible') base.status = 'offline';
        return base;
      }),
    };
  });

  // ---------------------------------------------------------------- contacts
  const peopleView = (ids: string[]) =>
    ids
      .map((id) => userById(id))
      .filter((u): u is UserRow => Boolean(u))
      .map((u) => {
        const v = publicUser(u);
        if (v.status === 'invisible') v.status = 'offline';
        return v;
      });
  const tellContactsChanged = (...ids: string[]) => {
    for (const id of ids) hub.toUser(id, { t: 'contacts.changed' });
  };

  app.get('/api/contacts', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const pending = pendingFor(me.id);
    return { contacts: contactIds(me.id), incoming: peopleView(pending.incoming), outgoing: peopleView(pending.outgoing) };
  });

  // Ask someone to be a contact, by username. The answer is the same whether or not that username exists, so this cannot be used to list who is here.
  app.post('/api/contacts', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const given = (req.body ?? {}) as { username?: unknown; code?: unknown };
    const username = String(given.code ?? given.username ?? '').trim().replace(/^@/, '');
    if (!username) return reply.code(400).send({ error: 'enter their username or friend code' });
    const outgoing = pendingFor(me.id).outgoing.length;
    if (outgoing >= 30) return reply.code(429).send({ error: 'too many requests waiting; wait for answers first' });
    const other = findUser(username, given.code !== undefined ? 'code' : undefined);
    if (other && other.id !== me.id && !blockedEitherWay(me.id, other.id)) {
      const result = requestContact(me.id, other.id);
      if (result === 'sent' || result === 'accepted') {
        tellContactsChanged(me.id, other.id);
        if (result === 'accepted') {
          hub.broadcastPresence(me.id);
          hub.broadcastPresence(other.id);
        }
      }
    }
    return { ok: true };
  });

  app.post('/api/contacts/:id/accept', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const other = (req.params as { id: string }).id;
    if (!acceptContact(me.id, other)) return reply.code(404).send({ error: 'no such request' });
    tellContactsChanged(me.id, other);
    hub.broadcastPresence(me.id);
    hub.broadcastPresence(other);
    return { ok: true };
  });

  // Decline a request, cancel your own, or remove a contact. Chats you already share stay.
  app.delete('/api/contacts/:id', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const other = (req.params as { id: string }).id;
    removeContact(me.id, other);
    tellContactsChanged(me.id, other);
    return { ok: true };
  });

  registerServerBackups(app, { requireUser, dataDir: env.DATA_DIR });

  registerSocial(app, {
    requireUser,
    checkPassword: (user, password) => typeof password === 'string' && verifyPassword(password, user.password_hash),
    tell: (id, message) => hub.toUser(id, message as never),
    presence: (id) => hub.broadcastPresence(id),
  });

  app.post('/api/users/:id/dm', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const other = (req.params as { id: string }).id;
    if (other === me.id || !userById(other)) return reply.code(400).send({ error: 'bad user' });
    // Chats start between people who know each other: contacts, or people already in a chat together.
    if (!canSee(me.id, other) || blockedEitherWay(me.id, other)) return reply.code(404).send({ error: 'not found' });

    const existing = db
      .prepare(
        `SELECT r.id FROM rooms r
         JOIN room_members a ON a.room_id = r.id AND a.user_id = ?
         JOIN room_members b ON b.room_id = r.id AND b.user_id = ?
         WHERE r.kind = 'dm'
         AND (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) = 2
         LIMIT 1`,
      )
      .get(me.id, other) as { id: string } | undefined;

    let roomId = existing?.id;
    if (!roomId) {
      roomId = nanoid();
      db.prepare(
        `INSERT INTO rooms (id, kind, name, topic, created_by, created_at) VALUES (?, 'dm', '', '', ?, ?)`,
      ).run(roomId, me.id, now());
      const stmt = db.prepare(
        'INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)',
      );
      stmt.run(roomId, me.id, now());
      stmt.run(roomId, other, now());
    }
    const view = roomView(roomId, me.id);
    hub.toUser(other, { t: 'room.updated', room: roomView(roomId, other) });
    return { room: view };
  });

  // ---------------------------------------------------------------- rooms
  app.get('/api/rooms', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const rows = db
      .prepare(
        `SELECT r.id FROM rooms r JOIN room_members m ON m.room_id = r.id
         WHERE m.user_id = ?`,
      )
      .all(me.id) as { id: string }[];
    const rooms = rows.map((r) => roomView(r.id, me.id)).filter(Boolean);
    rooms.sort((a, b) => {
      const at = a!.lastMessage?.createdAt ?? a!.createdAt;
      const bt = b!.lastMessage?.createdAt ?? b!.createdAt;
      return bt - at;
    });
    return { rooms };
  });

  app.post('/api/rooms', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const { name, topic, memberIds: ids, encrypted } = req.body as {
      name?: string;
      topic?: string;
      memberIds?: string[];
      encrypted?: boolean;
    };
    if (!name) return reply.code(400).send({ error: 'a room needs a name' });
    const roomId = nanoid();
    db.prepare(
      `INSERT INTO rooms (id, kind, name, topic, encrypted, created_by, created_at) VALUES (?, 'group', ?, ?, ?, ?, ?)`,
    ).run(roomId, name.slice(0, 80), (topic ?? '').slice(0, 200), encrypted ? 1 : 0, me.id, now());
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)',
    );
    stmt.run(roomId, me.id, now());
    for (const id of ids ?? []) if (userById(id) && canSee(me.id, id) && !blockedEitherWay(me.id, id)) stmt.run(roomId, id, now());

    for (const member of memberIds(roomId)) {
      hub.toUser(member, { t: 'room.updated', room: roomView(roomId, member) });
    }
    return { room: roomView(roomId, me.id) };
  });

  // Toggle a room's end-to-end encryption, or rename it. Membership required.
  app.patch('/api/rooms/:id', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const roomId = (req.params as { id: string }).id;
    if (!isMember(roomId, me.id)) return reply.code(403).send({ error: 'not a member' });
    const { encrypted, name, topic } = req.body as {
      encrypted?: boolean;
      name?: string;
      topic?: string;
    };
    const before = db.prepare('SELECT kind, name FROM rooms WHERE id = ?').get(roomId) as { kind: string; name: string } | undefined;
    if (!before) return reply.code(404).send({ error: 'no such room' });
    // A direct chat is named after the other person, so only a group has a name of its own to change.
    if (before.kind !== 'group' && (name || topic !== undefined)) return reply.code(400).send({ error: 'only a group chat can be renamed' });
    if (name !== undefined && !name.trim()) return reply.code(400).send({ error: 'a group needs a name' });
    db.prepare(
      `UPDATE rooms
       SET encrypted = COALESCE(?, encrypted),
           name = COALESCE(?, name),
           topic = COALESCE(?, topic)
       WHERE id = ?`,
    ).run(
      encrypted === undefined ? null : encrypted ? 1 : 0,
      name ? name.trim().slice(0, 80) : null,
      topic === undefined ? null : topic.slice(0, 200),
      roomId,
    );
    if (name && name.trim().slice(0, 80) !== before.name) hub.toRoom(roomId, { t: 'room.event', roomId, text: `${me.display_name} renamed the group to “${name.trim().slice(0, 80)}”` });
    for (const member of memberIds(roomId)) {
      hub.toUser(member, { t: 'room.updated', room: roomView(roomId, member) });
    }
    return { room: roomView(roomId, me.id) };
  });

  // Leave a group chat. The leaver's client drops the room; everyone still in
  // it gets a system line and a refreshed member list. Empty rooms are deleted.
  app.post('/api/rooms/:id/leave', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const roomId = (req.params as { id: string }).id;
    if (!isMember(roomId, me.id)) return reply.code(403).send({ error: 'not a member' });
    const room = db.prepare('SELECT kind FROM rooms WHERE id = ?').get(roomId) as
      | { kind: string }
      | undefined;
    if (!room) return reply.code(404).send({ error: 'no such room' });
    if (room.kind !== 'group') return reply.code(400).send({ error: 'only group chats can be left' });

    db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(roomId, me.id);
    hub.toUser(me.id, { t: 'room.removed', roomId });

    const remaining = memberIds(roomId);
    if (remaining.length === 0) {
      db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
    } else {
      passOnGroup(roomId, me.id);
      hub.toRoom(roomId, { t: 'room.event', roomId, text: `${me.display_name} left the group` });
      for (const member of remaining) {
        hub.toUser(member, { t: 'room.updated', room: roomView(roomId, member) });
      }
    }
    return { ok: true };
  });

  // Add people to a group chat (see groupMembers.ts for who may). Everyone already in it, and the new people, get the refreshed group.
  app.post('/api/rooms/:id/members', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const roomId = (req.params as { id: string }).id;
    try {
      const result = addMembers(roomId, me.id, (req.body as { userIds?: unknown } | undefined)?.userIds);
      if (result.added.length) {
        const names = result.added.map((id) => userById(id)?.display_name ?? 'someone');
        hub.toRoom(roomId, { t: 'room.event', roomId, text: `${me.display_name} added ${names.join(', ')}` });
        for (const member of memberIds(roomId)) hub.toUser(member, { t: 'room.updated', room: roomView(roomId, member) });
      }
      return { room: roomView(roomId, me.id), added: result.added, skipped: result.skipped };
    } catch (e) {
      if (e instanceof MemberError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });

  // Remove someone from a group chat (only the person who made it may; anyone can leave with /leave).
  app.delete('/api/rooms/:id/members/:userId', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const { id: roomId, userId } = req.params as { id: string; userId: string };
    try {
      const gone = userById(userId);
      removeMember(roomId, me.id, userId);
      hub.toUser(userId, { t: 'room.removed', roomId });
      hub.toRoom(roomId, { t: 'room.event', roomId, text: `${me.display_name} removed ${gone?.display_name ?? 'someone'}` });
      for (const member of memberIds(roomId)) hub.toUser(member, { t: 'room.updated', room: roomView(roomId, member) });
      return { room: roomView(roomId, me.id) };
    } catch (e) {
      if (e instanceof MemberError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });

  // Group pictures: like profile pictures, but shared with the room's members.
  app.post('/api/rooms/:id/avatar', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const roomId = (req.params as { id: string }).id;
    if (!isMember(roomId, me.id)) return reply.code(403).send({ error: 'not a member' });
    const data = await req.file({ limits: { fileSize: MAX_AVATAR } });
    if (!data) return reply.code(400).send({ error: 'no file' });
    const ext = AVATAR_EXT[data.mimetype ?? ''];
    if (!ext || ext === '.gif') return reply.code(400).send({ error: 'images only (png, jpg, webp)' });
    const id = `rv_${nanoid(16)}${ext}`;
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(path.join(uploadsDir, id));
      data.file.pipe(out);
      data.file.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
    });
    const previous =
      (db.prepare('SELECT avatar FROM rooms WHERE id = ?').get(roomId) as { avatar: string } | undefined)
        ?.avatar ?? '';
    db.prepare('UPDATE rooms SET avatar = ? WHERE id = ?').run(id, roomId);
    if (previous) fs.rm(path.join(uploadsDir, previous), { force: true }, () => {});
    for (const member of memberIds(roomId)) {
      hub.toUser(member, { t: 'room.updated', room: roomView(roomId, member) });
    }
    return { room: roomView(roomId, me.id) };
  });

  app.delete('/api/rooms/:id/avatar', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const roomId = (req.params as { id: string }).id;
    if (!isMember(roomId, me.id)) return reply.code(403).send({ error: 'not a member' });
    const previous =
      (db.prepare('SELECT avatar FROM rooms WHERE id = ?').get(roomId) as { avatar: string } | undefined)
        ?.avatar ?? '';
    db.prepare("UPDATE rooms SET avatar = '' WHERE id = ?").run(roomId);
    if (previous) fs.rm(path.join(uploadsDir, previous), { force: true }, () => {});
    for (const member of memberIds(roomId)) {
      hub.toUser(member, { t: 'room.updated', room: roomView(roomId, member) });
    }
    return { room: roomView(roomId, me.id) };
  });

  app.get('/api/room-avatars/:id', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const id = (req.params as { id: string }).id;
    const mime = AVATAR_MIME[path.extname(id)];
    const filePath = path.join(uploadsDir, id);
    if (!/^rv_[A-Za-z0-9_-]{8,32}\.(png|jpg|webp)$/.test(id) || !mime || !fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'not found' });
    }
    reply
      .header('content-type', mime)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(fs.createReadStream(filePath));
  });

  app.get('/api/rooms/:id/messages', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const roomId = (req.params as { id: string }).id;
    if (!isMember(roomId, me.id)) return reply.code(403).send({ error: 'not a member' });
    const { before, limit } = req.query as { before?: string; limit?: string };
    const take = Math.min(Number(limit) || 50, 200);
    const rows = (
      before
        ? db
            .prepare(
              `SELECT * FROM messages WHERE room_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
            )
            .all(roomId, Number(before), take)
        : db
            .prepare(`SELECT * FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?`)
            .all(roomId, take)
    ) as MessageRow[];
    return { messages: rows.reverse().map(fullMessage) };
  });

  // Everything ever shared in a room — pictures, files, voice notes — in one
  // browsable list. VLC's lesson: having a feature nobody can find is the same
  // as not having it, so the media lives where the conversation does.
  app.get('/api/rooms/:id/media', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const roomId = (req.params as { id: string }).id;
    if (!isMember(roomId, me.id)) return reply.code(403).send({ error: 'not a member' });
    const { before, limit } = req.query as { before?: string; limit?: string };
    const take = Math.min(Number(limit) || 60, 200);
    const sql = `SELECT a.id, a.filename, a.mime, a.size, a.width, a.height, a.encrypted,
                        a.envelope, a.created_at, a.message_id, m.user_id
                   FROM attachments a JOIN messages m ON m.id = a.message_id
                  WHERE a.room_id = ? AND m.deleted_at IS NULL${
                    before ? ' AND a.created_at < ?' : ''
                  }
                  ORDER BY a.created_at DESC LIMIT ?`;
    const rows = (
      before
        ? db.prepare(sql).all(roomId, Number(before), take)
        : db.prepare(sql).all(roomId, take)
    ) as {
      id: string;
      filename: string;
      mime: string;
      size: number;
      width: number | null;
      height: number | null;
      encrypted: number;
      envelope: string;
      created_at: number;
      message_id: string;
      user_id: string;
    }[];
    return {
      media: rows.map((r) => ({
        id: r.id,
        filename: r.filename,
        mime: r.mime,
        size: r.size,
        width: r.width,
        height: r.height,
        encrypted: r.encrypted,
        envelope: r.envelope,
        createdAt: r.created_at,
        messageId: r.message_id,
        userId: r.user_id,
      })),
    };
  });

  app.post('/api/rooms/:id/messages', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const roomId = (req.params as { id: string }).id;
    if (!isMember(roomId, me.id)) return reply.code(403).send({ error: 'not a member' });
    if (dmBlocked(roomId, me.id)) return reply.code(403).send({ error: 'this person is not receiving your messages' });
    const { body, replyTo } = req.body as { body?: string; replyTo?: string };
    if (!body || !body.trim()) return reply.code(400).send({ error: 'empty message' });
    // A reply must point at a message in this same room, or it is dropped.
    let replyId: string | null = null;
    if (replyTo) {
      const parent = messageById(replyTo);
      if (parent && parent.room_id === roomId) replyId = parent.id;
    }
    const id = nanoid();
    db.prepare(
      `INSERT INTO messages (id, room_id, user_id, body, created_at, reply_to) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, roomId, me.id, body.slice(0, 16000), now(), replyId);
    const message = messageById(id)!;
    notifyNewMessage(roomId, message);
    return { message: fullMessage(message) };
  });

  // Archive or unarchive a chat for me only. Archived chats leave the main list and stop notifying; their unread count is kept.
  app.post('/api/rooms/:id/archive', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const roomId = (req.params as { id: string }).id;
    if (!isMember(roomId, me.id)) return reply.code(403).send({ error: 'not a member' });
    const archived = (req.body as { archived?: unknown } | undefined)?.archived !== false;
    setArchived(roomId, me.id, archived);
    const room = roomView(roomId, me.id);
    hub.toUser(me.id, { t: 'room.updated', room } as never);
    return { room };
  });

  app.post('/api/rooms/:id/read', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const roomId = (req.params as { id: string }).id;
    if (!isMember(roomId, me.id)) return reply.code(403).send({ error: 'not a member' });
    const at = now();
    db.prepare('UPDATE room_members SET last_read_at = ? WHERE room_id = ? AND user_id = ?').run(
      at,
      roomId,
      me.id,
    );
    // Tell the room, so the sender's ticks fill in without a reload.
    hub.toRoom(roomId, { t: 'read', roomId, userId: me.id, at });
    return { ok: true };
  });

  /** Pin or unpin a message for the whole room. */
  app.post('/api/messages/:id/pin', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const m = messageById((req.params as { id: string }).id);
    if (!m || !isMember(m.room_id, me.id)) return reply.code(403).send({ error: 'not allowed' });
    const existing = db
      .prepare('SELECT 1 FROM room_pins WHERE room_id = ? AND message_id = ?')
      .get(m.room_id, m.id);
    if (existing) {
      db.prepare('DELETE FROM room_pins WHERE room_id = ? AND message_id = ?').run(m.room_id, m.id);
    } else {
      db.prepare(
        'INSERT INTO room_pins (room_id, message_id, pinned_by, created_at) VALUES (?, ?, ?, ?)',
      ).run(m.room_id, m.id, me.id, now());
    }
    const pinned = pinIdsFor(m.room_id)
      .map((id) => messageById(id))
      .filter((x): x is MessageRow => Boolean(x))
      .map((x) => fullMessage(x));
    hub.toRoom(m.room_id, { t: 'pins', roomId: m.room_id, pinned });
    return { pinned };
  });

  /** Search every room you are in. */
  app.get('/api/search', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const { q } = req.query as { q?: string };
    const term = (q ?? '').trim();
    if (term.length < 2) return { results: [] };
    const like = `%${term.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const rows = db
      .prepare(
        `SELECT m.* FROM messages m
         JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = ?
         WHERE m.deleted_at IS NULL AND m.body LIKE ? ESCAPE '\\'
         ORDER BY m.created_at DESC LIMIT 60`,
      )
      .all(me.id, like) as MessageRow[];
    return {
      results: rows.map((m) => {
        const room = db.prepare('SELECT id, kind, name FROM rooms WHERE id = ?').get(m.room_id) as
          | { id: string; kind: string; name: string }
          | undefined;
        return {
          message: fullMessage(m),
          room: room ? { id: room.id, kind: room.kind, name: room.name } : null,
        };
      }),
    };
  });

  /** Forward a message's text into another room you are a member of. */
  app.post('/api/messages/:id/forward', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const src = messageById((req.params as { id: string }).id);
    if (!src || !isMember(src.room_id, me.id)) return reply.code(403).send({ error: 'not allowed' });
    const { roomId } = req.body as { roomId?: string };
    if (!roomId || !isMember(roomId, me.id)) return reply.code(403).send({ error: 'not a member' });
    if (dmBlocked(roomId, me.id)) return reply.code(403).send({ error: 'this person is not receiving your messages' });
    const id = nanoid();
    db.prepare(
      `INSERT INTO messages (id, room_id, user_id, body, created_at, forwarded) VALUES (?, ?, ?, ?, ?, 1)`,
    ).run(id, roomId, me.id, src.body.slice(0, 16000), now());
    const message = messageById(id)!;
    notifyNewMessage(roomId, message);
    return { message: fullMessage(message) };
  });

  app.post('/api/rooms/:id/nudge', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const roomId = (req.params as { id: string }).id;
    if (!isMember(roomId, me.id)) return reply.code(403).send({ error: 'not a member' });
    if (allowNudge(me.id, roomId)) hub.toRoom(roomId, { t: 'nudge', roomId, userId: me.id });
    return { ok: true };
  });

  app.post('/api/rooms/:id/attachments', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const roomId = (req.params as { id: string }).id;
    if (!isMember(roomId, me.id)) return reply.code(403).send({ error: 'not a member' });
    if (dmBlocked(roomId, me.id)) return reply.code(403).send({ error: 'this person is not receiving your messages' });

    const data = await req.file({ limits: { fileSize: MAX_UPLOAD } });
    if (!data) return reply.code(400).send({ error: 'no file' });

    const id = nanoid();
    const safeName = data.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'file';
    const stored = path.join(uploadsDir, id);
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(stored);
      data.file.pipe(out);
      data.file.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
    });
    if (data.file.truncated) {
      fs.rmSync(stored, { force: true });
      return reply.code(413).send({ error: 'file is too large' });
    }
    const size = fs.statSync(stored).size;
    const body = fieldValue(data.fields, 'body').slice(0, 16000);
    const isEncrypted = fieldValue(data.fields, 'encrypted') === '1';
    const envelope = isEncrypted ? fieldValue(data.fields, 'envelope').slice(0, 2000) : '';

    const messageId = nanoid();
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO messages (id, room_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(messageId, roomId, me.id, body, now());
      db.prepare(
        `INSERT INTO attachments (id, message_id, room_id, filename, mime, size, encrypted, envelope, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        messageId,
        roomId,
        safeName,
        data.mimetype || 'application/octet-stream',
        size,
        isEncrypted ? 1 : 0,
        envelope,
        now(),
      );
    });
    tx();

    const message = messageById(messageId)!;
    notifyNewMessage(roomId, message);
    return { message: fullMessage(message) };
  });

  // ---------------------------------------------------------------- messages
  app.patch('/api/messages/:id', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const m = messageById((req.params as { id: string }).id);
    if (!m || m.user_id !== me.id) return reply.code(403).send({ error: 'not yours' });
    const { body } = req.body as { body?: string };
    if (!body || !body.trim()) return reply.code(400).send({ error: 'empty message' });
    db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(
      body.slice(0, 16000),
      now(),
      m.id,
    );
    const updated = messageById(m.id)!;
    hub.toRoom(m.room_id, { t: 'message.updated', message: fullMessage(updated) });
    return { message: fullMessage(updated) };
  });

  app.delete('/api/messages/:id', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const m = messageById((req.params as { id: string }).id);
    if (!m || m.user_id !== me.id) return reply.code(403).send({ error: 'not yours' });
    eraseMessage(m.id);
    hub.toRoom(m.room_id, { t: 'message.deleted', roomId: m.room_id, id: m.id });
    return { ok: true };
  });

  app.post('/api/messages/:id/reactions', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const m = messageById((req.params as { id: string }).id);
    if (!m || !isMember(m.room_id, me.id)) return reply.code(403).send({ error: 'not allowed' });
    const { emoji } = req.body as { emoji?: string };
    if (!emoji) return reply.code(400).send({ error: 'no emoji' });
    const existing = db
      .prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
      .get(m.id, me.id, emoji);
    if (existing) {
      db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(
        m.id,
        me.id,
        emoji,
      );
    } else {
      db.prepare(
        'INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
      ).run(m.id, me.id, emoji, now());
    }
    const updated = messageById(m.id)!;
    hub.toRoom(m.room_id, { t: 'message.updated', message: fullMessage(updated) });
    return { message: fullMessage(updated) };
  });

  // ---------------------------------------------------------------- attachments
  app.get('/api/attachments/:id', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const row = db
      .prepare('SELECT * FROM attachments WHERE id = ?')
      .get((req.params as { id: string }).id) as
      | { id: string; room_id: string; filename: string; mime: string; size: number }
      | undefined;
    if (!row || !isMember(row.room_id, me.id)) return reply.code(404).send({ error: 'not found' });
    const filePath = path.join(uploadsDir, row.id);
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: 'not found' });
    // Never let an upload run as a page on our origin: active types download
    // instead, and everything is sandboxed and un-sniffed.
    const active = ACTIVE_MIME.test(row.mime);
    // Use the real size on disk, so a stale row can never promise more bytes than we send.
    const size = fs.statSync(filePath).size;
    const wantsDownload = (req.query as { download?: string }).download === '1';
    reply
      .header('content-type', active && !/^image\/svg/i.test(row.mime) ? 'application/octet-stream' : row.mime)
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      // allow-downloads: a sandboxed document may not start downloads otherwise, so
      // "Save image as" from an opened attachment failed until retried from the
      // browser's download manager. Still no scripts, so nothing can run.
      .header(
        'content-security-policy',
        "sandbox allow-downloads; default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'self'",
      )
      .header('content-disposition', contentDisposition(active || wantsDownload ? 'attachment' : 'inline', row.filename));
    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      return reply.code(416).header('content-range', `bytes */${size}`).send();
    }
    if (range) {
      return reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${size}`)
        .header('content-length', String(range.end - range.start + 1))
        .send(fs.createReadStream(filePath, { start: range.start, end: range.end }));
    }
    return reply.header('content-length', String(size)).send(fs.createReadStream(filePath));
  });

  // ---------------------------------------------------------------- link previews
  app.post('/api/preview', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const { url } = (req.body ?? {}) as { url?: unknown };
    if (typeof url !== 'string' || !url || url.length > 4096) return reply.code(400).send({ error: 'a web URL is required' });
    return { preview: await fetchPreview(url) };
  });

  // ---------------------------------------------------------------- speech
  // The assistant's voice: Microsoft Sam, spoken by the OpenSAPI4 engine that  // runs next to the app (see docs/DEPLOY-OMV.md). Cached per text + voice.
  app.get('/api/tts', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const { text, voice } = req.query as { text?: string; voice?: string };
    const clean = (text ?? '').trim();
    if (!clean) return reply.code(400).send({ error: 'text is required' });
    if (clean.length > TTS_TEXT_MAX) return reply.code(413).send({ error: 'text is too long' });
    const v = (voice ?? 'Sam').trim().slice(0, 40) || 'Sam';
    const key = createHash('sha1').update(`${v}\u0000${clean}`).digest('hex');

    const cached = ttsMemory.get(key);
    if (cached) {
      return reply.type('audio/wav').header('cache-control', 'private, max-age=86400').send(cached);
    }

    const file = path.join(ttsCacheDir, `${key}.wav`);
    try {
      const data = await fs.promises.readFile(file);
      rememberTts(key, data);
      return reply.type('audio/wav').header('cache-control', 'private, max-age=86400').send(data);
    } catch {
      /* not cached yet */
    }

    try {
      const res = await fetch(
        `${env.HEARTH_TTS_URL}/speak?voice=${encodeURIComponent(v)}&text=${encodeURIComponent(clean)}`,
      );
      if (!res.ok) throw new Error(`speech service said ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      rememberTts(key, data);
      void fs.promises.writeFile(file, data).catch(() => {});
      return reply.type('audio/wav').header('cache-control', 'private, max-age=86400').send(data);
    } catch {
      return reply.code(503).send({ error: 'speech is not available right now' });
    }
  });

  // Speech to text, so the assistant can read a voice note back to you. The
  // audio arrives as bytes rather than an attachment id: the client decrypts an
  // end-to-end encrypted note first, and the server never needs a key. Any
  // whisper-style service works (the whisper-asr-webservice API).
  app.post('/api/stt', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    if (!env.HEARTH_STT_URL) {
      return reply.code(503).send({ error: 'speech-to-text is not set up on this server' });
    }
    const data = await req.file({ limits: { fileSize: 25 * 1024 * 1024 } });
    if (!data) return reply.code(400).send({ error: 'no audio' });
    try {
      const bytes = await data.toBuffer();
      const form = new FormData();
      form.append(
        'audio_file',
        new Blob([new Uint8Array(bytes)], { type: data.mimetype || 'audio/webm' }),
        data.filename || 'note.webm',
      );
      const res = await fetch(
        `${env.HEARTH_STT_URL}/asr?output=json&task=transcribe&model=${encodeURIComponent(
          env.HEARTH_STT_MODEL,
        )}`,
        { method: 'POST', body: form },
      );
      if (!res.ok) throw new Error(`speech service said ${res.status}`);
      const out = (await res.json()) as {
        text?: string;
        segments?: { start?: number; end?: number; text?: string }[];
      };
      // Whisper reports when each phrase was spoken. The transcript can then be
      // navigated like subtitles — click a line to jump to that moment — instead
      // of being one opaque wall of text. A phrase with no usable end would never
      // highlight as it plays, so borrow the next phrase's start (or a few
      // seconds) to keep the timeline sane.
      const raw = (out.segments ?? [])
        .filter((s) => typeof s.start === 'number' && (s.text ?? '').trim().length > 0)
        .map((s) => ({
          start: Number(s.start) || 0,
          end: Number(s.end ?? NaN),
          text: (s.text ?? '').trim(),
        }));
      const segments = raw.map((s, i) => ({
        start: s.start,
        end:
          Number.isFinite(s.end) && s.end > s.start
            ? s.end
            : (raw[i + 1]?.start ?? s.start + 3),
        text: s.text,
      }));
      return { text: (out.text ?? '').trim(), segments };
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message || 'speech-to-text failed' });
    }
  });

  // ---------------------------------------------------------------- calls
  app.post('/api/rooms/:id/call/token', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const roomId = (req.params as { id: string }).id;
    if (!isMember(roomId, me.id)) return reply.code(403).send({ error: 'not a member' });
    // Identity is per device, not per user: two devices of one user must not
    // displace each other in the SFU (same identity = the older one is dropped).
    const body = (req.body ?? {}) as { device?: string };
    const device = typeof body.device === 'string' && body.device.length <= 64 ? body.device : 'web';
    const token = await media.mintToken({
      identity: `${me.id}:${device}`,
      name: me.display_name,
      room: mediaRoomName(roomId),
    });
    // The address clients connect to for media: the one set in the panel or the environment, else the address this request came in on
    // (the same machine, port 7880; wss on the standard port when it arrived over HTTPS, where the reverse proxy forwards /rtc).
    const explicit = sourceOf('livekitUrl') !== 'default';
    const secure = req.protocol === 'https';
    const url = explicit ? env.LIVEKIT_URL : secure ? `wss://${req.hostname}` : `ws://${req.hostname}:7880`;
    return { url, token, room: mediaRoomName(roomId) };
  });

  // ---------------------------------------------------------------- invites
  app.get('/api/invites', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const invites = db
      .prepare(
        `SELECT i.code, i.created_at, i.used_at, u.display_name AS used_by_name
         FROM invites i LEFT JOIN users u ON u.id = i.used_by
         WHERE i.created_by = ?
         ORDER BY i.created_at DESC`,
      )
      .all(me.id);
    return { invites };
  });

  app.post('/api/invites', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const code = nanoid(10);
    db.prepare('INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)').run(
      code,
      me.id,
      now(),
    );
    return { code };
  });

  app.delete('/api/invites/:code', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    db.prepare('DELETE FROM invites WHERE code = ? AND used_by IS NULL AND created_by = ?').run(
      (req.params as { code: string }).code,
      me.id,
    );
    return { ok: true };
  });

  // ---------------------------------------------------------------- e2ee device keys
  // Devices publish their X25519 public key; the random group key is wrapped to
  // each device and stored as opaque ciphertext. The server never sees the key.

  app.post('/api/e2ee/device', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const { deviceId, publicKey } = req.body as { deviceId?: string; publicKey?: string };
    if (!deviceId || !publicKey) {
      return reply.code(400).send({ error: 'deviceId and publicKey are required' });
    }
    db.prepare(
      `INSERT INTO e2ee_devices (id, user_id, public_key, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET public_key = excluded.public_key, user_id = excluded.user_id`,
    ).run(deviceId, me.id, publicKey, now());
    const wraps = db
      .prepare(
        `SELECT sender_device AS senderDevice, key_id AS keyId, ephemeral AS eph, nonce AS n, ciphertext AS ct
         FROM e2ee_wraps WHERE recipient_device = ?`,
      )
      .all(deviceId);
    const hasGroupKey = Boolean(db.prepare('SELECT 1 FROM e2ee_wraps LIMIT 1').get());
    return { wraps, hasGroupKey };
  });

  app.get('/api/e2ee/wraps', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const deviceId = (req.query as { deviceId?: string }).deviceId;
    if (!deviceId) return reply.code(400).send({ error: 'deviceId is required' });
    const owns = db
      .prepare('SELECT 1 FROM e2ee_devices WHERE id = ? AND user_id = ?')
      .get(deviceId, me.id);
    if (!owns) return reply.code(403).send({ error: 'not your device' });
    const wraps = db
      .prepare(
        `SELECT sender_device AS senderDevice, key_id AS keyId, ephemeral AS eph, nonce AS n, ciphertext AS ct
         FROM e2ee_wraps WHERE recipient_device = ?`,
      )
      .all(deviceId);
    return { wraps };
  });

  app.get('/api/e2ee/devices', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const devices = db
      .prepare(
        `SELECT d.id, d.user_id AS userId, u.display_name AS displayName,
                d.public_key AS publicKey, d.created_at AS createdAt
         FROM e2ee_devices d JOIN users u ON u.id = d.user_id
         ORDER BY d.created_at`,
      )
      .all() as { id: string }[];
    const keyRows = db
      .prepare('SELECT recipient_device AS device, key_id AS keyId FROM e2ee_wraps')
      .all() as { device: string; keyId: string }[];
    const byDevice = new Map<string, string[]>();
    for (const row of keyRows) {
      const list = byDevice.get(row.device) ?? [];
      list.push(row.keyId);
      byDevice.set(row.device, list);
    }
    return { devices: devices.map((d) => ({ ...d, keyIds: byDevice.get(d.id) ?? [] })) };
  });

  app.post('/api/e2ee/wrap', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const { senderDevice, recipientDevice, keyId, wrapped } = req.body as {
      senderDevice?: string;
      recipientDevice?: string;
      keyId?: string;
      wrapped?: { eph?: string; n?: string; ct?: string };
    };
    if (!senderDevice || !recipientDevice || !keyId || !wrapped?.eph || !wrapped?.n || !wrapped?.ct) {
      return reply.code(400).send({ error: 'incomplete wrap' });
    }
    db.prepare(
      `INSERT INTO e2ee_wraps (recipient_device, sender_device, key_id, ephemeral, nonce, ciphertext, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(recipient_device, sender_device, key_id)
       DO UPDATE SET ephemeral = excluded.ephemeral, nonce = excluded.nonce,
                     ciphertext = excluded.ciphertext, created_at = excluded.created_at`,
    ).run(recipientDevice, senderDevice, keyId, wrapped.eph, wrapped.n, wrapped.ct, now());
    return { ok: true };
  });

  // ---------------------------------------------------------------- push
  app.get('/api/push/key', async () => {
    const { pushEnabled, pushPublicKey } = await import('./push.js');
    return { enabled: pushEnabled(), key: pushPublicKey() };
  });

  app.post('/api/push/subscribe', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const { subscription } = (req.body ?? {}) as { subscription?: unknown };
    const { isValidSubscription, saveSubscription } = await import('./push.js');
    if (!isValidSubscription(subscription)) {
      return reply.code(400).send({ error: 'that is not a usable push subscription' });
    }
    saveSubscription(me.id, subscription);
    return { ok: true };
  });

  /** Is push set up, and is *this device* registered for me? The settings page
   *  trusts this over the browser's own permission flag. */
  app.get('/api/push/status', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const { endpoint } = req.query as { endpoint?: string };
    const { pushEnabled, subscriptionStatus } = await import('./push.js');
    return { enabled: pushEnabled(), ...subscriptionStatus(me.id, endpoint) };
  });

  /** A real push, through the real pipeline, to every device I have registered. */
  app.post('/api/push/test', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const { pushToUser } = await import('./push.js');
    const result = await pushToUser(me.id, {
      title: 'Hearth',
      body: 'This is what a message alert looks like.',
      tag: 'hearth-test',
      url: '/',
      renotify: true,
    });
    return result;
  });

  app.post('/api/push/unsubscribe', async (req, reply) => {
    const me = requireUser(req, reply);
    if (!me) return;
    const { endpoint } = req.body as { endpoint?: string };
    if (endpoint) {
      const { removeSubscription } = await import('./push.js');
      removeSubscription(endpoint);
    }
    return { ok: true };
  });
}

function colorFor(seed: string): string {
  const palette = ['#7c6cff', '#ff6bb5', '#45c4a0', '#ffa94d', '#4dabf7', '#f06595', '#94d82d'];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length]!;
}
