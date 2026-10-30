// End-to-end check of a running server, over HTTP only, the way a client would use it.
//
//   node scripts/smoke.mjs http://localhost:8080
//
// It needs a server with no accounts yet (a fresh data folder). It creates the first administrator, exercises the admin API,
// registration, sign-in rules and backup storage, then exits 0 on success and 1 on the first failure.
import assert from 'node:assert/strict';

const base = (process.argv[2] || process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');

class Client {
  jar = new Map();
  async call(path, { method = 'GET', body, raw, headers = {} } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined && !raw) h['content-type'] = 'application/json';
    if (raw) h['content-type'] = 'application/octet-stream';
    const res = await fetch(base + path, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), duplex: raw ? 'half' : undefined });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
      if (v === '' || /max-age=0/i.test(c)) this.jar.delete(k); else this.jar.set(k, v);
    }
    let json = null;
    const text = await res.text();
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
}

let step = 0;
async function check(name, fn) {
  step++;
  try {
    await fn();
    console.log(`  ok  ${String(step).padStart(2)}  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${String(step).padStart(2)}  ${name}\n${e && e.stack ? e.stack : e}`);
    process.exit(1);
  }
}

const admin = new Client();
const alice = new Client();
const anon = new Client();
const password = 'correct horse battery';

console.log(`smoke test against ${base}`);

await check('the server answers and says what it is', async () => {
  const r = await anon.call('/api/health');
  assert.equal(r.status, 200);
  const i = (await anon.call('/api/server/info')).json;
  assert.equal(i.software, 'hearth-server');
  assert.equal(i.apiVersion, 1);
  assert.equal(i.setupNeeded, true, 'run this against a fresh data folder');
  assert.equal(i.registration, 'invite');
});

await check('the admin panel and its files are served', async () => {
  for (const p of ['/admin', '/admin/admin.js', '/admin/admin.css', '/admin/ui.js', '/admin/icons.js', '/admin/v-settings.js', '/admin/inter.woff2', '/admin/mono.woff2']) {
    const r = await anon.call(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
  }
  assert.equal((await anon.call('/admin/../package.json')).status, 404);
});

await check('the admin API refuses people who are not signed in', async () => {
  for (const p of ['/api/admin/status', '/api/admin/users', '/api/admin/config']) assert.equal((await anon.call(p)).status, 401, p);
});

await check('first-run setup makes the administrator and signs them in', async () => {
  const bad = await anon.call('/api/admin/setup', { method: 'POST', body: { username: 'root', password: 'short' } });
  assert.equal(bad.status, 400);
  const r = await admin.call('/api/admin/setup', { method: 'POST', body: { username: 'root', password } });
  assert.equal(r.status, 200, r.text);
  const me = (await admin.call('/api/auth/me')).json;
  assert.equal(me.user.username, 'root');
  assert.equal(me.admin, true);
});

await check('setup works only once', async () => {
  const r = await anon.call('/api/admin/setup', { method: 'POST', body: { username: 'evil', password } });
  assert.equal(r.status, 409);
  assert.equal((await anon.call('/api/server/info')).json.setupNeeded, false);
});

await check('the session cookie is Secure only over HTTPS, so plain-HTTP home servers work', async () => {
  const plain = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'root', password }) });
  const plainCookie = plain.headers.getSetCookie().find((c) => c.startsWith('hearth_session='));
  assert.ok(plainCookie, 'a session cookie is set');
  assert.match(plainCookie, /HttpOnly/i);
  assert.match(plainCookie, /SameSite=Lax/i);
  assert.doesNotMatch(plainCookie, /;\s*Secure/i, 'not Secure over plain HTTP');
  const proxied = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ username: 'root', password }) });
  const proxiedCookie = proxied.headers.getSetCookie().find((c) => c.startsWith('hearth_session='));
  assert.match(proxiedCookie, /;\s*Secure/i, 'Secure behind an HTTPS proxy');
});

await check('status reports the server', async () => {
  const s = (await admin.call('/api/admin/status')).json;
  assert.equal(s.counts.users, 1);
  assert.equal(s.counts.admins, 1);
  assert.ok(s.uptimeSeconds >= 0 && s.dataDir);
});

await check('registration needs a code until an administrator opens it', async () => {
  const r = await anon.call('/api/auth/register', { method: 'POST', body: { username: 'nobody', password } });
  assert.equal(r.status, 400);
  const put = await admin.call('/api/admin/config', { method: 'PUT', body: { changes: { registration: 'open' } } });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.restart, false);
  assert.equal((await anon.call('/api/server/info')).json.registration, 'open');
  assert.equal((await anon.call('/api/auth/config')).json.registration, 'open');
  const opened = await new Client().call('/api/auth/register', { method: 'POST', body: { username: 'walkin', password } });
  assert.equal(opened.status, 200, opened.text);
  await admin.call('/api/admin/config', { method: 'PUT', body: { changes: { registration: 'invite' } } });
  assert.equal((await new Client().call('/api/auth/register', { method: 'POST', body: { username: 'walkin2', password } })).status, 400);
});

await check('settings are validated and secrets are never returned', async () => {
  const bad = await admin.call('/api/admin/config', { method: 'PUT', body: { changes: { backupQuotaMb: 'lots' } } });
  assert.equal(bad.status, 400);
  const ok = await admin.call('/api/admin/config', { method: 'PUT', body: { changes: { registrationKey: 'house-key-1234', serverName: 'Smoke Test' } } });
  assert.equal(ok.status, 200);
  const view = ok.json.settings.find((s) => s.key === 'registrationKey');
  assert.equal(view.value, null);
  assert.equal(view.set, true);
  assert.ok(!JSON.stringify(ok.json).includes('house-key-1234'));
  assert.equal((await anon.call('/api/server/info')).json.name, 'Smoke Test');
  assert.equal((await anon.call('/api/server/info')).json.houseKey, true);
});

await check('the house key lets someone in, an invite code does too, and codes are single use', async () => {
  const viaKey = await alice.call('/api/auth/register', { method: 'POST', body: { invite: 'house-key-1234', username: 'alice', password } });
  assert.equal(viaKey.status, 200, viaKey.text);
  const code = (await admin.call('/api/admin/invites', { method: 'POST' })).json.code;
  assert.ok(code);
  const bob = new Client();
  const r1 = await bob.call('/api/auth/register', { method: 'POST', body: { invite: code, username: 'bob', password } });
  assert.equal(r1.status, 200, r1.text);
  const r2 = await new Client().call('/api/auth/register', { method: 'POST', body: { invite: code, username: 'bob2', password } });
  assert.equal(r2.status, 400);
  const list = (await admin.call('/api/admin/invites')).json.invites;
  assert.equal(list.find((i) => i.code === code).usedBy, 'bob');
});

await check('an ordinary person cannot use the admin API', async () => {
  for (const p of ['/api/admin/status', '/api/admin/users']) assert.equal((await alice.call(p)).status, 403, p);
  assert.equal((await alice.call('/api/auth/me')).json.admin, false);
  assert.equal((await alice.call('/api/admin/config', { method: 'PUT', body: { changes: { registration: 'open' } } })).status, 403);
});

await check('a cross-site admin request is refused', async () => {
  const r = await admin.call('/api/admin/invites', { method: 'POST', headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

await check('people can list, switch off and switch on', async () => {
  const users = (await admin.call('/api/admin/users')).json.users;
  const a = users.find((u) => u.username === 'alice');
  assert.ok(a && !a.isAdmin && !a.disabled);
  assert.equal((await admin.call(`/api/admin/users/${a.id}`, { method: 'PATCH', body: { disabled: true } })).status, 200);
  assert.equal((await alice.call('/api/auth/me')).status, 401, 'sessions end at once');
  const login = await new Client().call('/api/auth/login', { method: 'POST', body: { username: 'alice', password } });
  assert.equal(login.status, 403);
  assert.equal((await admin.call(`/api/admin/users/${a.id}`, { method: 'PATCH', body: { disabled: false } })).status, 200);
  assert.equal((await alice.call('/api/auth/login', { method: 'POST', body: { username: 'alice', password } })).status, 200);
});

await check('a password reset gives a temporary password and ends sessions', async () => {
  const a = (await admin.call('/api/admin/users')).json.users.find((u) => u.username === 'alice');
  const r = await admin.call(`/api/admin/users/${a.id}/reset-password`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.ok(r.json.password.length >= 16);
  assert.equal((await alice.call('/api/auth/me')).status, 401);
  assert.equal((await new Client().call('/api/auth/login', { method: 'POST', body: { username: 'alice', password } })).status, 401);
  assert.equal((await alice.call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: r.json.password } })).status, 200);
});

await check('the last administrator cannot be removed, switched off or demoted', async () => {
  const root = (await admin.call('/api/admin/users')).json.users.find((u) => u.username === 'root');
  assert.equal((await admin.call(`/api/admin/users/${root.id}`, { method: 'PATCH', body: { disabled: true } })).status, 409);
  assert.equal((await admin.call(`/api/admin/users/${root.id}`, { method: 'PATCH', body: { isAdmin: false } })).status, 409);
  assert.equal((await admin.call(`/api/admin/users/${root.id}`, { method: 'DELETE' })).status, 409);
});

await check('backups are stored, listed, limited and visible to the administrator', async () => {
  const data = Buffer.from('sealed backup bytes '.repeat(50));
  const put = await alice.call('/api/backup/files/smoke-1.embkup', { method: 'PUT', raw: data });
  assert.equal(put.status, 200, put.text);
  const list = (await alice.call('/api/backup/files')).json;
  assert.equal(list.files.length, 1);
  assert.equal(list.files[0].size, data.length);
  const got = await alice.call('/api/backup/files/smoke-1.embkup');
  assert.equal(got.status, 200);
  assert.equal(got.text, data.toString());
  assert.equal((await new Client().call('/api/backup/files')).status, 401);
  const overview = (await admin.call('/api/admin/backups')).json;
  assert.equal(overview.backups.find((b) => b.username === 'alice').files.length, 1);
  // The limit changes at once, with no restart.
  assert.equal((await admin.call('/api/admin/config', { method: 'PUT', body: { changes: { backupQuotaMb: '1' } } })).status, 200);
  const big = await alice.call('/api/backup/files/smoke-2.embkup', { method: 'PUT', raw: Buffer.alloc(1024 * 1024 + 10, 1) });
  assert.equal(big.status, 507, 'over the new quota');
  assert.equal((await admin.call('/api/admin/config', { method: 'PUT', body: { changes: { backupStorage: 'off' } } })).status, 200);
  assert.equal((await alice.call('/api/backup/files')).status, 404, 'switched off');
  await admin.call('/api/admin/config', { method: 'PUT', body: { changes: { backupStorage: 'on', backupQuotaMb: '4096' } } });
  const a = (await admin.call('/api/admin/users')).json.users.find((u) => u.username === 'alice');
  assert.equal((await admin.call(`/api/admin/backups/${a.id}/smoke-1.embkup`, { method: 'DELETE' })).status, 200);
  assert.equal((await alice.call('/api/backup/files')).json.files.length, 0);
});

await check('the route list and the activity log are there for the administrator', async () => {
  const routes = (await admin.call('/api/admin/routes')).json.routes;
  assert.ok(routes.some((r) => r.method === 'POST' && r.url === '/api/auth/login'));
  assert.ok(routes.some((r) => r.url === '/api/server/info'));
  const log = (await admin.call('/api/admin/log')).json.log;
  assert.ok(log.some((l) => l.action === 'setup'));
  assert.ok(log.some((l) => l.action === 'disable'));
  assert.ok(log.some((l) => l.action === 'reset-password'));
});

await check('removing a person deletes the account', async () => {
  const b = (await admin.call('/api/admin/users')).json.users.find((u) => u.username === 'bob');
  assert.equal((await admin.call(`/api/admin/users/${b.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await new Client().call('/api/auth/login', { method: 'POST', body: { username: 'bob', password } })).status, 401);
});

console.log('\nall checks passed');
