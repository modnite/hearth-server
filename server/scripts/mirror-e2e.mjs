// Three real servers on this machine: link two mirrors to a main server, copy, fail over, hand back, promote for good.
//
//   npm run build && node scripts/mirror-e2e.mjs
//
// Failover is made quick through MIRROR_FAILOVER_SECONDS and MIRROR_TICK_SECONDS. Exits 0 on success.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-mirror-'));
const password = 'correct horse battery';

class Client {
  jar = new Map();
  constructor(base) { this.base = base; }
  async call(p, { method = 'GET', body } = {}) {
    const h = {};
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) h['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(this.base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    } catch (e) {
      return { status: 0, json: null, text: String(e) };
    }
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  }
}

const nodes = {};
function start(name, port) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, PORT: String(port), DATA_DIR: dir, NODE_ENV: 'development', LOG_LEVEL: 'warn', MIRROR_FAILOVER_SECONDS: '4', MIRROR_TICK_SECONDS: '1', HEARTH_NAME: name, HEARTH_SUPERVISED: '1' };
  const child = spawn(process.execPath, ['dist/index.js'], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] });
  nodes[name] = { name, port, dir, child, base: `http://127.0.0.1:${port}` };
  return nodes[name];
}
async function up(n) {
  for (let i = 0; i < 100; i += 1) {
    if ((await new Client(n.base).call('/api/health')).status === 200) return;
    await sleep(150);
  }
  throw new Error(`${n.name} did not start`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 25000) {
  const t = Date.now();
  let last;
  while (Date.now() - t < ms) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ''}`);
}
let step = 0;
async function check(name, fn) {
  step += 1;
  try { await fn(); console.log(`  ok  ${String(step).padStart(2)}  ${name}`); } catch (e) { console.error(`FAIL  ${String(step).padStart(2)}  ${name}\n${e?.stack ?? e}`); cleanup(); process.exit(1); }
}
function cleanup() {
  for (const n of Object.values(nodes)) try { n.child.kill(); } catch { /* gone */ }
}
process.on('exit', cleanup);

const A = start('A', 18601);
const B = start('B', 18602);
const C = start('C', 18603);
await Promise.all([up(A), up(B), up(C)]);

const adminA = new Client(A.base);
let roomId;
const info = async (n) => (await new Client(n.base).call('/api/server/info')).json;
const cluster = async (c) => (await c.call('/api/admin/cluster')).json;

await check('the main server is set up with a person and a group', async () => {
  assert.equal((await adminA.call('/api/admin/setup', { method: 'POST', body: { username: 'root', password } })).status, 200);
  const code = (await adminA.call('/api/admin/invites', { method: 'POST' })).json.code;
  const r = await new Client(A.base).call('/api/auth/register', { method: 'POST', body: { invite: code, username: 'alice', password } });
  assert.equal(r.status, 200, r.text);
  const made = await adminA.call('/api/rooms', { method: 'POST', body: { name: 'Kitchen', memberIds: [r.json.user.id] } });
  assert.equal(made.status, 200, made.text);
  roomId = made.json.room.id;
  assert.equal((await adminA.call(`/api/rooms/${roomId}/messages`, { method: 'POST', body: { body: 'first' } })).status, 200);
});

await check('two mirrors link with a code each', async () => {
  for (const n of [B, C]) {
    const made = await adminA.call('/api/admin/cluster/add-mirror', { method: 'POST', body: { origin: A.base, name: n.name } });
    assert.equal(made.status, 200, made.text);
    // a fresh mirror has no people yet, so it may link without signing in
    const joined = await new Client(n.base).call('/api/admin/cluster/join', { method: 'POST', body: { code: made.json.code, name: n.name, origin: n.base } });
    assert.equal(joined.status, 200, joined.text);
  }
  const c = await cluster(adminA);
  assert.deepEqual(c.nodes.map((x) => [x.name, x.rank]), [['A', 0], ['B', 1], ['C', 2]]);
});

await check('a mirror holds a copy: the same people can sign in on it and the group is there', async () => {
  const onB = new Client(B.base);
  await until('B to copy', async () => (await onB.call('/api/auth/login', { method: 'POST', body: { username: 'root', password } })).status === 200);
  const c = await until('B copy status', async () => { const s = await cluster(onB); return s.lastSync?.ok ? s : null; });
  assert.equal(c.role, 'mirror');
  assert.equal(c.writable, false);
});

await check('a mirror refuses to be written to and tells apps where to go', async () => {
  const onB = new Client(B.base);
  await onB.call('/api/auth/login', { method: 'POST', body: { username: 'root', password } });
  const r = await onB.call(`/api/rooms/${roomId}/messages`, { method: 'POST', body: { body: 'nope' } });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'standby');
  assert.equal(r.json.main, A.base);
  const i = await until('B to know all three', async () => { const x = await info(B); return x.cluster?.nodes.length === 3 ? x : null; });
  assert.equal(i.cluster.writable, false);
});

await check('new messages reach the mirrors by themselves', async () => {
  assert.equal((await adminA.call(`/api/rooms/${roomId}/messages`, { method: 'POST', body: { body: 'second' } })).status, 200);
  const Database = (await import('better-sqlite3')).default;
  for (const n of [B, C]) {
    await until(`${n.name} to have the message`, () => {
      const d = new Database(path.join(n.dir, 'hearth.db'), { readonly: true });
      try { return d.prepare("SELECT COUNT(*) AS c FROM messages WHERE body = 'second'").get().c === 1; } finally { d.close(); }
    });
  }
});

let portable;
await check('a sign-in can be made to carry over to another server of the group', async () => {
  const r = await adminA.call('/api/auth/portable', { method: 'POST', body: {} });
  assert.equal(r.status, 200, r.text);
  portable = r.json.token;
  await sleep(2500);
});

await check('when the main server goes away the first mirror takes over by itself, the second follows it', async () => {
  A.child.kill();
  await until('B to take over', async () => (await info(B)).cluster?.writable === true, 30000);
  const onB = new Client(B.base);
  assert.equal((await onB.call('/api/auth/login', { method: 'POST', body: { username: 'root', password } })).status, 200);
  const adopted = new Client(B.base);
  assert.equal((await adopted.call('/api/auth/adopt', { method: 'POST', body: { token: portable } })).status, 200, 'the carried sign-in works on the stand-in');
  assert.equal((await adopted.call('/api/auth/me')).json.user.username, 'root');
  const sent = await onB.call(`/api/rooms/${roomId}/messages`, { method: 'POST', body: { body: 'while A was away' } });
  assert.equal(sent.status, 200, sent.text);
  assert.equal((await info(C)).cluster.writable, false, 'only one mirror serves');
  const Database = (await import('better-sqlite3')).default;
  await until('C to follow B', () => {
    const d = new Database(path.join(C.dir, 'hearth.db'), { readonly: true });
    try { return d.prepare("SELECT COUNT(*) AS c FROM messages WHERE body = 'while A was away'").get().c === 1; } finally { d.close(); }
  });
});

let epochAfter;
await check('the main server comes back, takes back what was written meanwhile, and the stand-in steps down', async () => {
  const again = start('A', 18601);
  await up(again);
  await until('A to serve again', async () => (await info(A)).cluster?.writable === true, 30000);
  await until('B to step down', async () => (await info(B)).cluster?.writable === false, 30000);
  const onA = new Client(A.base);
  assert.equal((await onA.call('/api/auth/login', { method: 'POST', body: { username: 'root', password } })).status, 200);
  const msgs = (await onA.call(`/api/rooms/${roomId}/messages`)).json.messages.map((m) => m.body);
  assert.ok(msgs.includes('while A was away'), `A has what B collected: ${msgs}`);
  epochAfter = (await info(A)).cluster.epoch;
  assert.ok(epochAfter >= 3, 'the epoch only goes up');
  assert.ok(fs.readdirSync(path.join(A.dir, 'replaced')).some((f) => f.startsWith('hearth-')), 'the old data is kept as a dated file');
});

await check('the mirrors follow the main server again', async () => {
  const onA = new Client(A.base);
  await onA.call('/api/auth/login', { method: 'POST', body: { username: 'root', password } });
  assert.equal((await onA.call(`/api/rooms/${roomId}/messages`, { method: 'POST', body: { body: 'after handback' } })).status, 200);
  const Database = (await import('better-sqlite3')).default;
  for (const n of [B, C]) {
    await until(`${n.name} to have the message`, () => {
      const d = new Database(path.join(n.dir, 'hearth.db'), { readonly: true });
      try { return d.prepare("SELECT COUNT(*) AS c FROM messages WHERE body = 'after handback'").get().c === 1; } finally { d.close(); }
    });
  }
});

await check('a mirror can be made the main server for good, and the old main server becomes its mirror', async () => {
  const onC = new Client(C.base);
  await until('C login', async () => (await onC.call('/api/auth/login', { method: 'POST', body: { username: 'root', password } })).status === 200);
  assert.equal((await onC.call('/api/admin/cluster/main', { method: 'POST' })).status, 200);
  await until('C to serve', async () => (await info(C)).cluster?.writable === true, 15000);
  await until('A to become a mirror', async () => (await info(A)).cluster?.writable === false, 30000);
  await until('B to follow C', async () => { const s = await cluster(await (async () => { const c = new Client(B.base); await c.call('/api/auth/login', { method: 'POST', body: { username: 'root', password } }); return c; })()); return s.primaryId === (await cluster(onC)).nodeId; });
  assert.ok((await info(C)).cluster.epoch > epochAfter);
});

console.log('mirror end-to-end: all good');
cleanup();
process.exit(0);
