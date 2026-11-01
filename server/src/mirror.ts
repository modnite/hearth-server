import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { currentUser } from './auth.js';
import { cfg, updateConfig } from './config.js';
import { db, now } from './db.js';
import { env } from './env.js';
import { decide, type Action, type PeerView } from './mirrorLogic.js';
import { applySnapshot, changeCount, diffFiles, exportSnapshot, listFiles, localSessions, pruneOld, safePath, storeFile, type RemoteFile } from './mirrorSync.js';
import { hub } from './realtime.js';

/**
 * Mirrors. A server can have any number of mirrors: other Hearth servers that keep a copy of everything and take over by themselves when the
 * main server is gone, then hand back by themselves when it returns. Nobody has to do anything at the moment it matters. The only manual
 * steps are the two that need a person: linking a mirror (paste a code) and, if the main server is gone for good, making a mirror the main one.
 *
 * How it hangs together, in short:
 *  - Every server in the group has an id, an address and a rank (0 is the main server, 1, 2... the mirrors in the order they were added) and
 *    they share one secret key, which is inside the code that links a mirror. All talk between servers is under /api/mirror and needs that key.
 *  - A mirror asks the others "are you serving people?" every few seconds and copies the database (a snapshot swapped in inside one
 *    transaction) and the files from whichever one is.
 *  - If nobody is serving for 30 seconds and every mirror ranked above this one is gone too, this one starts serving (epoch + 1). People's apps
 *    follow the list of servers they were given and move over by themselves.
 *  - When the main server is back it asks the stand-in to stop (freeze), copies what the stand-in collected, bumps the epoch and tells it to
 *    release. The copy of its own data from before is kept as a dated file.
 *  - The epoch only goes up. Two stand-ins after a broken network: the higher epoch, then the lower rank, wins, and the other copies from it.
 */

const FAILOVER_MS = Number(process.env.MIRROR_FAILOVER_SECONDS || 30) * 1000;
const TICK_MS = Number(process.env.MIRROR_TICK_SECONDS || 5) * 1000;
const PEER_TIMEOUT_MS = 3000;
const SHARED_SETTINGS = ['serverName', 'motd', 'registration', 'registrationKey', 'backupStorage', 'backupQuotaMb', 'backupMaxFileMb', 'browser', 'crashReports', 'crashKeepDays'];

export interface Node {
  id: string;
  name: string;
  url: string;
  rank: number;
}
interface Pending {
  id: string;
  rank: number;
  name: string;
  at: number;
}
interface LastSync {
  at: number;
  ok: boolean;
  error?: string;
  from: string;
  fingerprint: string;
  epoch: number;
}
interface Saved {
  nodeId: string;
  key: string;
  role: 'primary' | 'mirror';
  acting: boolean;
  epoch: number;
  primaryId: string;
  nodes: Node[];
  pending: Pending[];
  selfUrl: string;
  name: string;
  lastSync: LastSync | null;
  /** The next snapshot replaces data this server made itself: keep a dated copy first. */
  needBackup: boolean;
}
interface PeerState {
  nodeId: string;
  role: 'primary' | 'mirror';
  writable: boolean;
  epoch: number;
  primaryId: string;
  fingerprint: string;
  nodes: Node[];
  settings: Record<string, string>;
}

const file = path.join(env.DATA_DIR, 'mirror.json');
const replacedDir = path.join(env.DATA_DIR, 'replaced');
const bootId = crypto.randomBytes(4).toString('hex');

function fresh(): Saved {
  const id = nanoid(10);
  return { nodeId: id, key: '', role: 'primary', acting: false, epoch: 1, primaryId: id, nodes: [], pending: [], selfUrl: '', name: '', lastSync: null, needBackup: false };
}

function load(): Saved {
  try {
    return { ...fresh(), ...(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Saved>) };
  } catch {
    const s = fresh();
    try {
      fs.mkdirSync(env.DATA_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    } catch {
      /* read-only data dir: the id lives only until restart */
    }
    return s;
  }
}

let saved = load();

function save(): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------------------------------------------- state

let frozen = false;
let frozenTimer: ReturnType<typeof setTimeout> | null = null;
/** The main server that has just started does not serve until it has looked for a stand-in that took over while it was away. */
let recovering = saved.role === 'primary' && saved.nodes.length > 1;
let lastServing = Date.now();
let lastError = '';
let nextPullAt = 0;
let busy = false;
const peerCache = new Map<string, { at: number; reachable: boolean; state?: PeerState }>();

export const clustered = (): boolean => saved.nodes.length > 1 || saved.role === 'mirror';

export function isWritable(): boolean {
  if (!clustered()) return true;
  if (frozen) return false;
  return saved.role === 'primary' ? !recovering : saved.acting;
}

const selfNode = (): Node => saved.nodes.find((n) => n.id === saved.nodeId) ?? { id: saved.nodeId, name: saved.name, url: saved.selfUrl, rank: saved.role === 'primary' ? 0 : 99 };
const fingerprint = (): string => `${bootId}:${changeCount(db)}`;

function sharedSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SHARED_SETTINGS) out[k] = cfg(k);
  return out;
}

function stateView(): PeerState {
  return {
    nodeId: saved.nodeId,
    role: saved.role,
    writable: isWritable(),
    epoch: saved.epoch,
    primaryId: saved.primaryId,
    fingerprint: fingerprint(),
    nodes: saved.nodes,
    settings: sharedSettings(),
  };
}

function log(action: string, detail = ''): void {
  try {
    db.prepare('INSERT INTO admin_log (at, who, action, detail) VALUES (?, ?, ?, ?)').run(now(), 'servers', action, detail.slice(0, 300));
  } catch {
    /* the log table is not there yet, or this is a standby; the console still has it */
  }
  console.log(`[mirror] ${action} ${detail}`);
}

/** What clients are told about the group so they can move between servers themselves. */
export function clusterInfo(): { epoch: number; writable: boolean; nodes: Array<{ url: string; rank: number }> } | undefined {
  if (!clustered()) return undefined;
  return { epoch: saved.epoch, writable: isWritable(), nodes: saved.nodes.filter((n) => n.url).map((n) => ({ url: n.url, rank: n.rank })) };
}

// ---------------------------------------------------------------------------------------------------------------- talking to the others

async function call(node: Node, method: 'GET' | 'POST', p: string, body?: unknown, ms = PEER_TIMEOUT_MS): Promise<Response> {
  return fetch(node.url.replace(/\/+$/, '') + p, {
    method,
    headers: { authorization: `Bearer ${saved.key}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.timeout(ms),
  });
}

async function getState(node: Node): Promise<PeerState | null> {
  try {
    const res = await call(node, 'GET', '/api/mirror/state');
    if (!res.ok) return null;
    return (await res.json()) as PeerState;
  } catch {
    return null;
  }
}

const others = (): Node[] => saved.nodes.filter((n) => n.id !== saved.nodeId && n.url);

async function pollPeers(): Promise<Array<{ node: Node; state: PeerState | null }>> {
  const out = await Promise.all(others().map(async (node) => ({ node, state: await getState(node) })));
  for (const { node, state } of out) peerCache.set(node.id, { at: Date.now(), reachable: !!state, state: state ?? undefined });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- copying

function backupOwnData(why: string): void {
  try {
    fs.mkdirSync(replacedDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    exportSnapshot(db, path.join(replacedDir, `hearth-${stamp}-${why}.db`));
    pruneOld(replacedDir, 5);
  } catch (e) {
    log('backup failed', String(e));
  }
}

async function pullFiles(node: Node, prune: boolean): Promise<void> {
  const res = await call(node, 'GET', '/api/mirror/files', undefined, 30_000);
  if (!res.ok) throw new Error(`file list: ${res.status}`);
  const remote = ((await res.json()) as { files: RemoteFile[] }).files;
  const { fetch: want, remove } = diffFiles(listFiles(env.DATA_DIR), remote);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const f = want[next++];
      if (!f) return;
      const r = await call(node, 'GET', `/api/mirror/file?p=${encodeURIComponent(f.p)}`, undefined, 10 * 60_000);
      if (!r.ok) throw new Error(`file ${f.p}: ${r.status}`);
      await storeFile(env.DATA_DIR, f, r.body);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (prune) for (const p of remove) {
    const full = safePath(env.DATA_DIR, p);
    if (full) fs.rmSync(full, { force: true });
  }
}

/** Download a snapshot from the node and swap it in, then the files. */
async function pullAll(node: Node, st: PeerState, opts: { prune: boolean }): Promise<void> {
  const res = await call(node, 'GET', '/api/mirror/snapshot', undefined, 5 * 60_000);
  if (!res.ok || !res.body) throw new Error(`snapshot: ${res.status}`);
  fs.mkdirSync(replacedDir, { recursive: true });
  const tmp = path.join(replacedDir, `incoming-${process.pid}.db`);
  try {
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), zlib.createGunzip(), fs.createWriteStream(tmp));
    if (saved.needBackup) {
      backupOwnData(saved.role === 'mirror' ? 'before-mirroring' : 'before-handback');
      saved.needBackup = false;
    }
    const r = applySnapshot(db, tmp, localSessions);
    log('copied', `${r.rows} rows from ${node.name || node.url}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  await pullFiles(node, opts.prune);
  applySettings(st.settings);
  saved.lastSync = { at: Date.now(), ok: true, from: node.id, fingerprint: st.fingerprint, epoch: st.epoch };
  save();
}

function applySettings(settings: Record<string, string> | undefined): void {
  if (!settings) return;
  const changes: Record<string, string> = {};
  for (const k of SHARED_SETTINGS) if (typeof settings[k] === 'string' && settings[k] !== cfg(k)) changes[k] = settings[k]!;
  if (Object.keys(changes).length === 0) return;
  try {
    updateConfig(changes);
  } catch (e) {
    log('settings not copied', String(e));
  }
}

/** Take over what the source says about the group (who is in it, the epoch, which one is the main server). */
function adoptGroup(st: PeerState): void {
  if (!st.nodes.some((n) => n.id === saved.nodeId)) return;
  saved.nodes = st.nodes.map((n) => (n.id === saved.nodeId ? { ...n, url: saved.selfUrl || n.url } : n));
  saved.primaryId = st.primaryId;
  if (st.epoch > saved.epoch) saved.epoch = st.epoch;
}

async function follow(node: Node, st: PeerState): Promise<void> {
  if (!st.nodes.some((n) => n.id === saved.nodeId)) {
    log('removed from the group', 'this server keeps its data and now runs on its own');
    leaveGroup();
    return;
  }
  adoptGroup(st);
  const last = saved.lastSync;
  if (last?.ok && last.from === node.id && last.fingerprint === st.fingerprint && last.epoch === st.epoch) {
    save();
    return;
  }
  if (Date.now() < nextPullAt) return;
  const started = Date.now();
  try {
    await pullAll(node, st, { prune: true });
    lastError = '';
  } catch (e) {
    lastError = `copying from ${node.name || node.url}: ${(e as Error).message}`;
    saved.lastSync = { at: Date.now(), ok: false, error: lastError, from: node.id, fingerprint: '', epoch: st.epoch };
    save();
  }
  // A large database is not fetched more often than it takes to fetch: wait four times as long as the last copy took.
  nextPullAt = Date.now() + 4 * (Date.now() - started);
}

// ---------------------------------------------------------------------------------------------------------------- changes of role

function stopServing(): void {
  hub.disconnectAll(4001, 'this server is no longer the main one');
}

function leaveGroup(): void {
  saved.role = 'primary';
  saved.acting = false;
  saved.nodes = [];
  saved.pending = [];
  saved.key = '';
  saved.primaryId = saved.nodeId;
  saved.lastSync = null;
  recovering = false;
  save();
}

async function reclaim(node: Node): Promise<void> {
  recovering = true;
  try {
    const f = await call(node, 'POST', '/api/mirror/freeze');
    if (!f.ok) throw new Error(`freeze: ${f.status}`);
    const st = await getState(node);
    if (!st) throw new Error('lost the stand-in');
    saved.needBackup = true;
    await pullAll(node, st, { prune: false });
    saved.epoch = st.epoch + 1;
    saved.acting = false;
    recovering = false;
    save();
    log('took back', `from ${node.name || node.url}, epoch ${saved.epoch}`);
    await call(node, 'POST', '/api/mirror/release', { epoch: saved.epoch, primaryId: saved.nodeId }).catch(() => undefined);
    lastError = '';
  } catch (e) {
    lastError = `taking back from ${node.name || node.url}: ${(e as Error).message}`;
    log('could not take back', lastError);
    await call(node, 'POST', '/api/mirror/unfreeze').catch(() => undefined);
  }
}

async function demote(node: Node, st: PeerState): Promise<void> {
  log('stepping back', `${node.name || node.url} outranks this server`);
  saved.acting = false;
  saved.needBackup = true;
  saved.lastSync = null;
  save();
  stopServing();
  await follow(node, st);
}

async function rebase(node: Node, st: PeerState): Promise<void> {
  log('now a mirror', `${node.name || node.url} was made the main server`);
  saved.role = 'mirror';
  saved.acting = false;
  saved.needBackup = true;
  saved.lastSync = null;
  recovering = false;
  save();
  stopServing();
  await follow(node, st);
}

// ---------------------------------------------------------------------------------------------------------------- the loop

async function tick(): Promise<void> {
  if (busy || !clustered()) {
    if (!clustered()) recovering = false;
    return;
  }
  busy = true;
  try {
    const polled = await pollPeers();
    const peers: PeerView[] = polled.map(({ node, state }) => ({
      id: node.id,
      rank: node.rank,
      reachable: !!state,
      writable: !!state?.writable,
      epoch: state?.epoch ?? 0,
      primaryId: state?.primaryId ?? saved.primaryId,
    }));
    const me = selfNode();
    if (isWritable() || peers.some((p) => p.reachable && p.writable)) lastServing = Date.now();
    const action: Action = decide(
      { id: saved.nodeId, rank: me.rank, role: saved.role, acting: saved.acting, epoch: saved.epoch, primaryId: saved.primaryId },
      peers,
      Date.now() - lastServing,
      FAILOVER_MS,
    );
    const target = (id: string): { node: Node; state: PeerState } | null => {
      const p = polled.find((x) => x.node.id === id);
      return p?.state ? { node: p.node, state: p.state } : null;
    };
    switch (action.t) {
      case 'none':
        // The main server has looked and found no stand-in to take back from: it may serve.
        if (saved.role === 'primary') recovering = false;
        break;
      case 'follow': {
        const t = target(action.from);
        if (t) await follow(t.node, t.state);
        break;
      }
      case 'promote':
        saved.acting = true;
        saved.epoch = action.epoch;
        saved.lastSync = null;
        save();
        lastServing = Date.now();
        log('took over', `as the main server, epoch ${saved.epoch}`);
        break;
      case 'demote': {
        const t = target(action.to);
        if (t) await demote(t.node, t.state);
        break;
      }
      case 'reclaim': {
        const t = target(action.from);
        if (t) await reclaim(t.node);
        break;
      }
      case 'rebase': {
        const t = target(action.to);
        if (t) await rebase(t.node, t.state);
        break;
      }
    }
    // The main server also keeps the others informed about who is in the group, through its state; nothing else to push.
  } catch (e) {
    lastError = (e as Error).message;
  } finally {
    busy = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the loop, and link this server to a group at boot when it was given a code (for unattended setups). */
export function startMirror(): void {
  const code = process.env.HEARTH_MIRROR_CODE;
  if (code && saved.role === 'primary' && saved.nodes.length === 0) {
    const url = process.env.HEARTH_PUBLIC_URL || (env.HEARTH_DOMAIN !== 'localhost' ? `https://${env.HEARTH_DOMAIN}` : '');
    void joinGroup(code, cfg('serverName'), url).then(
      () => log('linked', 'from HEARTH_MIRROR_CODE'),
      (e) => log('could not link', String(e)),
    );
  }
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  void tick();
}

// ---------------------------------------------------------------------------------------------------------------- linking

const CODE_PREFIX = 'hm1.';

export function makeCode(origin: string, label: string): { code: string; id: string } {
  if (!saved.key) saved.key = crypto.randomBytes(32).toString('hex');
  if (!saved.selfUrl) saved.selfUrl = origin.replace(/\/+$/, '');
  if (!saved.name) saved.name = cfg('serverName');
  if (saved.nodes.length === 0) saved.nodes = [{ id: saved.nodeId, name: saved.name, url: saved.selfUrl, rank: 0 }];
  const rank = Math.max(0, ...saved.nodes.map((n) => n.rank), ...saved.pending.map((p) => p.rank)) + 1;
  const id = nanoid(10);
  saved.pending = saved.pending.filter((p) => Date.now() - p.at < 24 * 3600_000);
  saved.pending.push({ id, rank, name: label || `Mirror ${rank}`, at: Date.now() });
  save();
  const payload = Buffer.from(JSON.stringify({ k: saved.key, u: saved.selfUrl, i: id, r: rank })).toString('base64url');
  return { code: CODE_PREFIX + payload, id };
}

export async function joinGroup(code: string, name: string, url: string): Promise<void> {
  if (!code.startsWith(CODE_PREFIX)) throw new Error('that is not a mirror code');
  let c: { k: string; u: string; i: string; r: number };
  try {
    c = JSON.parse(Buffer.from(code.slice(CODE_PREFIX.length), 'base64url').toString('utf8')) as typeof c;
  } catch {
    throw new Error('that mirror code is damaged');
  }
  if (!c.k || !c.u || !c.i) throw new Error('that mirror code is damaged');
  if (!/^https?:\/\//.test(url)) throw new Error('this server needs a public address first');
  let res: Response;
  try {
    res = await fetch(`${c.u.replace(/\/+$/, '')}/api/mirror/join`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.k}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: c.i, name, url: url.replace(/\/+$/, '') }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('could not reach the main server at ' + c.u);
  }
  if (!res.ok) throw new Error(res.status === 404 ? 'the main server does not know this code (it may be used or too old)' : `the main server refused: ${res.status}`);
  const j = (await res.json()) as { nodes: Node[]; epoch: number; primaryId: string };
  saved = {
    ...fresh(),
    nodeId: c.i,
    key: c.k,
    role: 'mirror',
    epoch: j.epoch,
    primaryId: j.primaryId,
    nodes: j.nodes,
    selfUrl: url.replace(/\/+$/, ''),
    name,
    needBackup: true,
  };
  recovering = false;
  lastServing = Date.now();
  save();
  void tick();
}

/** A mirror becomes the main server for good. The others, and the old main server if it returns, follow it. */
export async function makeMain(): Promise<void> {
  const polled = await pollPeers();
  const epoch = Math.max(saved.epoch, ...polled.map((p) => p.state?.epoch ?? 0)) + 1;
  const rest = saved.nodes.filter((n) => n.id !== saved.nodeId).sort((a, b) => (a.id === saved.primaryId ? 1 : 0) - (b.id === saved.primaryId ? 1 : 0) || a.rank - b.rank);
  saved.nodes = [{ ...selfNode(), rank: 0 }, ...rest.map((n, i) => ({ ...n, rank: i + 1 }))];
  saved.role = 'primary';
  saved.acting = false;
  saved.primaryId = saved.nodeId;
  saved.epoch = epoch;
  recovering = false;
  frozen = false;
  save();
  log('made the main server', `epoch ${epoch}`);
}

export function removeNode(id: string): boolean {
  const before = saved.nodes.length + saved.pending.length;
  saved.nodes = saved.nodes.filter((n) => n.id !== id || n.id === saved.nodeId);
  saved.pending = saved.pending.filter((p) => p.id !== id);
  if (saved.nodes.length === 1 && saved.pending.length === 0) {
    saved.nodes = [];
    saved.key = '';
  }
  save();
  return before !== saved.nodes.length + saved.pending.length;
}

export function renameSelf(name: string, url: string): void {
  if (name) saved.name = name;
  if (url) saved.selfUrl = url.replace(/\/+$/, '');
  saved.nodes = saved.nodes.map((n) => (n.id === saved.nodeId ? { ...n, name: saved.name || n.name, url: saved.selfUrl || n.url } : n));
  save();
}

export function leave(): void {
  leaveGroup();
  log('left the group', 'this server runs on its own with its current data');
}

export function clusterStatus() {
  return {
    role: saved.role,
    acting: saved.acting,
    writable: isWritable(),
    recovering,
    frozen,
    epoch: saved.epoch,
    nodeId: saved.nodeId,
    primaryId: saved.primaryId,
    name: saved.name || cfg('serverName'),
    selfUrl: saved.selfUrl,
    clustered: clustered(),
    lastSync: saved.lastSync,
    error: lastError,
    pending: saved.pending.map((p) => ({ id: p.id, name: p.name, rank: p.rank, at: p.at })),
    nodes: saved.nodes
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .map((n) => {
        const c = peerCache.get(n.id);
        const self = n.id === saved.nodeId;
        return {
          id: n.id,
          name: n.name,
          url: n.url,
          rank: n.rank,
          self,
          main: n.id === saved.primaryId,
          reachable: self ? true : !!c?.reachable,
          writable: self ? isWritable() : !!c?.state?.writable,
          seenAt: self ? Date.now() : c?.at ?? 0,
        };
      }),
  };
}

// ---------------------------------------------------------------------------------------------------------------- routes

const keyOk = (req: FastifyRequest): boolean => {
  if (!saved.key) return false;
  const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(saved.key);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
};

function sameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Paths a server that is not serving people still answers. Everything else under /api gets "standby" and the apps move on to another server. */
const STANDBY_OK = ['/api/health', '/api/server/info', '/api/mirror/', '/api/auth/login', '/api/auth/logout', '/api/auth/me'];

export function registerMirror(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    if (isWritable()) return;
    const url = req.url.split('?')[0]!;
    if (url === '/ws' || url.startsWith('/ws/')) return reply.code(503).send({ error: 'standby' });
    if (!url.startsWith('/api/')) return;
    if (STANDBY_OK.some((p) => url === p || (p.endsWith('/') && url.startsWith(p)))) return;
    if (url.startsWith('/api/admin/') && (req.method === 'GET' || url.startsWith('/api/admin/cluster'))) return;
    const main = saved.nodes.find((n) => n.id === saved.primaryId);
    const acting = saved.nodes.find((n) => peerCache.get(n.id)?.state?.writable);
    return reply.code(503).header('retry-after', '5').send({ error: 'standby', moving: frozen, main: main?.url ?? null, serving: acting?.url ?? null });
  });

  const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (keyOk(req)) return true;
    void reply.code(401).send({ error: 'unauthorized' });
    return false;
  };
  const admin = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const me = currentUser(req);
    if (!me) {
      void reply.code(401).send({ error: 'unauthorized' });
      return false;
    }
    if (!me.is_admin) {
      void reply.code(403).send({ error: 'this needs an administrator' });
      return false;
    }
    if (req.method !== 'GET' && !sameOrigin(req)) {
      void reply.code(403).send({ error: 'cross-site request refused' });
      return false;
    }
    return true;
  };

  // ---- between servers
  app.get('/api/mirror/state', async (req, reply) => {
    if (!guard(req, reply)) return;
    reply.header('cache-control', 'no-store');
    return stateView();
  });

  app.get('/api/mirror/snapshot', async (req, reply) => {
    if (!guard(req, reply)) return;
    fs.mkdirSync(replacedDir, { recursive: true });
    const tmp = path.join(replacedDir, `outgoing-${nanoid(6)}.db`);
    exportSnapshot(db, tmp);
    const stream = fs.createReadStream(tmp).pipe(zlib.createGzip());
    const cleanup = (): void => fs.rmSync(tmp, { force: true });
    stream.on('close', cleanup);
    stream.on('error', cleanup);
    return reply.header('content-type', 'application/octet-stream').header('cache-control', 'no-store').send(stream);
  });

  app.get('/api/mirror/files', async (req, reply) => {
    if (!guard(req, reply)) return;
    return { files: listFiles(env.DATA_DIR) };
  });

  app.get('/api/mirror/file', async (req, reply) => {
    if (!guard(req, reply)) return;
    const full = safePath(env.DATA_DIR, String((req.query as { p?: string }).p ?? ''));
    if (!full || !fs.existsSync(full)) return reply.code(404).send({ error: 'not found' });
    return reply.header('content-type', 'application/octet-stream').header('content-length', String(fs.statSync(full).size)).send(fs.createReadStream(full));
  });

  app.post('/api/mirror/join', async (req, reply) => {
    if (!guard(req, reply)) return;
    const b = (req.body ?? {}) as { id?: string; name?: string; url?: string };
    const p = saved.pending.find((x) => x.id === b.id);
    if (!p || typeof b.url !== 'string' || !/^https?:\/\//.test(b.url)) return reply.code(404).send({ error: 'unknown code' });
    saved.pending = saved.pending.filter((x) => x.id !== p.id);
    saved.nodes = saved.nodes.filter((n) => n.id !== p.id);
    saved.nodes.push({ id: p.id, name: String(b.name || p.name).slice(0, 60), url: b.url.replace(/\/+$/, ''), rank: p.rank });
    save();
    log('mirror linked', `${b.name ?? p.name} (rank ${p.rank})`);
    return { nodes: saved.nodes, epoch: saved.epoch, primaryId: saved.primaryId };
  });

  app.post('/api/mirror/freeze', async (req, reply) => {
    if (!guard(req, reply)) return;
    frozen = true;
    stopServing();
    if (frozenTimer) clearTimeout(frozenTimer);
    // If the main server never comes back for the data, do not stay frozen for good.
    frozenTimer = setTimeout(() => { frozen = false; }, 180_000);
    frozenTimer.unref();
    return { ok: true, epoch: saved.epoch };
  });

  app.post('/api/mirror/unfreeze', async (req, reply) => {
    if (!guard(req, reply)) return;
    frozen = false;
    return { ok: true };
  });

  app.post('/api/mirror/release', async (req, reply) => {
    if (!guard(req, reply)) return;
    const b = (req.body ?? {}) as { epoch?: number; primaryId?: string };
    if (typeof b.epoch === 'number' && b.epoch > saved.epoch) saved.epoch = b.epoch;
    if (typeof b.primaryId === 'string') saved.primaryId = b.primaryId;
    saved.acting = false;
    saved.lastSync = null;
    frozen = false;
    save();
    log('handed back', 'the main server has its data again');
    return { ok: true };
  });

  // ---- for the panel
  app.get('/api/admin/cluster', async (req, reply) => {
    if (!admin(req, reply)) return;
    return clusterStatus();
  });

  app.post('/api/admin/cluster/add-mirror', async (req, reply) => {
    if (!admin(req, reply)) return;
    if (saved.role === 'mirror') return reply.code(409).send({ error: 'add mirrors on the main server' });
    const b = (req.body ?? {}) as { origin?: string; name?: string };
    const origin = typeof b.origin === 'string' ? b.origin : '';
    if (!/^https?:\/\//.test(origin) && !saved.selfUrl) return reply.code(400).send({ error: 'the address of this server is missing' });
    return makeCode(origin, typeof b.name === 'string' ? b.name.trim().slice(0, 60) : '');
  });

  app.post('/api/admin/cluster/join', async (req, reply) => {
    const noUsers = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n === 0;
    if (!noUsers && !admin(req, reply)) return;
    if (noUsers && !sameOrigin(req)) return reply.code(403).send({ error: 'cross-site request refused' });
    if (clustered()) return reply.code(409).send({ error: 'this server is already in a group' });
    const b = (req.body ?? {}) as { code?: string; name?: string; origin?: string };
    try {
      await joinGroup(String(b.code ?? '').trim(), String(b.name || cfg('serverName')).slice(0, 60), String(b.origin ?? ''));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    return { ok: true };
  });

  app.post('/api/admin/cluster/main', async (req, reply) => {
    if (!admin(req, reply)) return;
    if (saved.role !== 'mirror') return reply.code(409).send({ error: 'this server is already the main server' });
    await makeMain();
    return { ok: true };
  });

  app.post('/api/admin/cluster/leave', async (req, reply) => {
    if (!admin(req, reply)) return;
    leave();
    return { ok: true };
  });

  app.put('/api/admin/cluster/self', async (req, reply) => {
    if (!admin(req, reply)) return;
    const b = (req.body ?? {}) as { name?: string; url?: string };
    if (b.url && !/^https?:\/\/[^\s]+$/.test(b.url)) return reply.code(400).send({ error: 'the address must start with http:// or https://' });
    renameSelf(String(b.name ?? '').trim().slice(0, 60), String(b.url ?? '').trim());
    return { ok: true };
  });

  app.delete('/api/admin/cluster/nodes/:id', async (req, reply) => {
    if (!admin(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!removeNode(id)) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });
}
