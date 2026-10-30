// The Hearth server admin panel. Plain ES modules, no build step. Everything shown is built with
// textContent (never innerHTML), so a name or note someone typed cannot run as markup.

const app = document.getElementById('app');
const state = { info: null, me: null, tab: 'overview' };

const TABS = [
  ['overview', 'Overview'],
  ['settings', 'Settings'],
  ['people', 'People'],
  ['invites', 'Invites'],
  ['backups', 'Backups'],
  ['activity', 'Activity'],
  ['api', 'For client builders'],
];

// ---- small helpers ---------------------------------------------------------------------------------------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') { // property by property through the CSSOM: the page's CSP forbids style attributes and cssText
      for (const decl of String(v).split(';')) { const i = decl.indexOf(':'); if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); }
    }
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Something went wrong (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(text, bad = false) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: bad ? 'alert' : 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3500);
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
function when(ms) { return ms ? new Date(ms).toLocaleString() : 'never'; }
function ago(ms) {
  if (!ms) return 'never';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
function duration(sec) {
  const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d} d ${hh} h` : hh ? `${hh} h ${m} min` : `${m} min`;
}

function dialog(title, body, buttons) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { 'aria-labelledby': 'dlg-title' }, h('h2', { id: 'dlg-title' }, title), body,
      h('div', { class: 'row' }, buttons.map((b) => h('button', { class: b.class || '', type: 'button', onclick: () => { dlg.close(); resolve(b.value); } }, b.label))));
    dlg.addEventListener('cancel', () => resolve(null));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(null); });
    document.body.append(dlg);
    dlg.showModal();
  });
}
const confirmBox = async (title, text, yes = 'Yes', danger = false) =>
  (await dialog(title, h('p', null, text), [{ label: 'Cancel', value: false }, { label: yes, value: true, class: danger ? 'danger' : 'primary' }])) === true;

// ---- first run and sign-in --------------------------------------------------------------------------------
function logo() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'logo');
  svg.innerHTML = '<circle cx="16" cy="16" r="16" fill="#e8590c"/><path d="M9 10h14a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-8l-5 4v-4a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z" fill="#fff"/>';
  return svg;
}

function authScreen(setup) {
  const user = h('input', { type: 'text', id: 'u', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const pass = h('input', { type: 'password', id: 'p', autocomplete: setup ? 'new-password' : 'current-password', required: true, minlength: setup ? 8 : false });
  const code = h('input', { type: 'text', id: 'c', inputmode: 'numeric', autocomplete: 'one-time-code' });
  const codeField = h('div', { class: 'field', hidden: true }, h('label', { for: 'c' }, 'Two-step code'), code);
  const msg = h('p', { class: 'small', role: 'alert', style: 'color:var(--bad)' });
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    msg.textContent = '';
    try {
      if (setup) await api('/api/admin/setup', { method: 'POST', body: { username: user.value.trim(), password: pass.value } });
      else await api('/api/auth/login', { method: 'POST', body: { username: user.value.trim(), password: pass.value, code: code.value.trim() || undefined } });
      await boot();
    } catch (err) {
      if (err.message.includes('two-step')) codeField.hidden = false;
      msg.textContent = err.message;
    }
  } },
    h('div', { class: 'field' }, h('label', { for: 'u' }, 'Username'), user),
    h('div', { class: 'field' }, h('label', { for: 'p' }, setup ? 'Password (8 or more characters)' : 'Password'), pass),
    codeField,
    msg,
    h('button', { class: 'primary', type: 'submit' }, setup ? 'Create administrator' : 'Sign in'));
  app.replaceChildren(h('div', { class: 'center' },
    h('div', { class: 'brand', style: 'display:flex;gap:10px;align-items:center;margin-bottom:16px' }, logo(), h('h1', { style: 'margin:0' }, state.info ? state.info.name : 'Hearth')),
    h('div', { class: 'card' },
      h('h2', null, setup ? 'Set up this server' : 'Administrator sign-in'),
      setup ? h('p', { class: 'muted' }, 'This server has no accounts yet. The account you make now is the administrator. You can add more administrators and invite everyone else afterwards.')
        : h('p', { class: 'muted' }, 'Sign in with an administrator account.'),
      form)));
  user.focus();
}

// ---- layout -------------------------------------------------------------------------------------------------
function shell(content) {
  const nav = h('nav', { class: 'tabs', 'aria-label': 'Sections' }, TABS.map(([id, label]) =>
    h('button', { type: 'button', 'aria-current': state.tab === id ? 'page' : false, onclick: () => { state.tab = id; location.hash = id; render(); } }, label)));
  app.replaceChildren(h('div', { class: 'shell' },
    h('header', { class: 'top' },
      h('div', { class: 'brand' }, logo(), h('span', null, state.info.name), h('span', { class: 'badge' }, `v${state.info.version}`)),
      h('div', { class: 'spacer' }),
      h('span', { class: 'muted small' }, `Signed in as ${state.me.user.username}`),
      h('button', { type: 'button', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); await boot(); } }, 'Sign out')),
    nav, content));
}

async function render() {
  const view = { overview, settings, people, invites, backups, activity, apiDocs }[state.tab] || overview;
  shell(h('p', { class: 'muted' }, 'Loading…'));
  try {
    shell(await view());
  } catch (err) {
    if (err.status === 401 || err.status === 403) return boot();
    shell(h('div', { class: 'banner bad', role: 'alert' }, err.message));
  }
}

// ---- overview -----------------------------------------------------------------------------------------------
async function overview() {
  const s = await api('/api/admin/status');
  const stat = (n, l) => h('div', { class: 'stat' }, h('div', { class: 'n' }, String(n)), h('div', { class: 'l' }, l));
  const total = s.storageBytes.uploads + s.storageBytes.backups + s.storageBytes.database || 1;
  const pct = (n) => `${Math.max(0, (n / total) * 100).toFixed(1)}%`;
  const warnings = [];
  if (!s.secrets.sessionSecretChanged) warnings.push('SESSION_SECRET is still the built-in default. Set a long random value in the server environment.');
  if (!s.calls.configured) warnings.push('Voice and video calls are not set up. Add LiveKit under Settings, or start the stack with the calls profile.');
  else if (!s.calls.reachable) warnings.push('LiveKit is set up but this server cannot reach it. Calls will fail until it can.');
  if (state.info.registration === 'open') warnings.push('Anyone who can reach this server can create an account. Switch to Invite under Settings if that is not what you want.');
  const origin = location.origin;
  return h('div', null,
    warnings.map((w) => h('div', { class: 'banner warn', role: 'note' }, w)),
    h('div', { class: 'card' },
      h('h2', null, 'Connect a client'),
      h('p', null, 'In Ember or any other Hearth client, use this as the server address:'),
      h('p', null, h('span', { class: 'secretbox' }, origin), ' ', h('button', { type: 'button', onclick: async () => { await navigator.clipboard?.writeText(origin).catch(() => {}); toast('Copied'); } }, 'Copy'))),
    h('div', { class: 'grid' },
      stat(s.counts.users, 'people'), stat(s.counts.signedIn, 'signed in right now'), stat(s.counts.rooms, 'chats and rooms'),
      stat(s.counts.messages, 'messages'), stat(s.counts.attachments, 'files shared'), stat(s.counts.openInvites, 'unused invites')),
    h('div', { class: 'card' },
      h('h2', null, 'Storage'),
      h('div', { class: 'bar', role: 'img', 'aria-label': `Uploads ${bytes(s.storageBytes.uploads)}, backups ${bytes(s.storageBytes.backups)}, database ${bytes(s.storageBytes.database)}` },
        h('span', { class: 'a', style: `width:${pct(s.storageBytes.uploads)}` }), h('span', { class: 'b', style: `width:${pct(s.storageBytes.backups)}` }), h('span', { class: 'c', style: `width:${pct(s.storageBytes.database)}` })),
      h('div', { class: 'legend' },
        h('span', null, h('i', { style: 'background:var(--accent)' }), `Shared files ${bytes(s.storageBytes.uploads)}`),
        h('span', null, h('i', { style: 'background:#4dabf7' }), `Backups ${bytes(s.storageBytes.backups)}`),
        h('span', null, h('i', { style: 'background:#94d82d' }), `Database ${bytes(s.storageBytes.database)}`)),
      h('p', { class: 'muted small', style: 'margin-top:10px' }, `Everything lives in ${s.dataDir}. Back that folder up and you have backed up the server.`)),
    h('div', { class: 'card' },
      h('h2', null, 'Status'),
      h('p', null, 'Voice and video: ', s.calls.configured ? (s.calls.reachable ? h('span', { class: 'badge good' }, 'ready') : h('span', { class: 'badge bad' }, 'set up, not reachable')) : h('span', { class: 'badge' }, 'not set up')),
      h('p', null, 'Push notifications: ', s.push.configured ? h('span', { class: 'badge good' }, 'on') : h('span', { class: 'badge' }, 'off')),
      h('p', { class: 'muted small' }, `Up ${duration(s.uptimeSeconds)}, ${s.memoryMb} MB memory, Node ${s.node} on ${s.platform}, API version ${s.apiVersion}.`),
      s.supervised ? h('button', { type: 'button', class: 'danger', onclick: async () => {
        if (!(await confirmBox('Restart the server?', 'People are disconnected for a few seconds and reconnect by themselves.', 'Restart', true))) return;
        await api('/api/admin/restart', { method: 'POST' }).then(() => toast('Restarting…')).catch((e) => toast(e.message, true));
      } }, 'Restart server') : h('p', { class: 'muted small' }, 'This server is not run by something that restarts it, so settings marked "restart" need you to restart it yourself.')));
}

// ---- settings -----------------------------------------------------------------------------------------------
async function settings() {
  const { settings: list } = await api('/api/admin/config');
  const groups = [...new Set(list.map((s) => s.group))];
  const inputs = new Map();
  const make = (s) => {
    let input;
    if (s.type === 'choice') input = h('select', { id: `s-${s.key}` }, s.choices.map((c) => h('option', { value: c, selected: c === s.value }, c)));
    else if (s.type === 'secret') input = h('input', { type: 'password', id: `s-${s.key}`, autocomplete: 'new-password', placeholder: s.set ? 'Set. Type to replace.' : 'Not set' });
    else if (s.type === 'number') input = h('input', { type: 'number', id: `s-${s.key}`, value: s.value, min: s.min, max: s.max });
    else input = h('input', { type: 'text', id: `s-${s.key}`, value: s.value, autocomplete: 'off', spellcheck: 'false' });
    inputs.set(s.key, { s, input });
    return h('div', { class: 'field' },
      h('label', { for: `s-${s.key}` }, s.label, h('span', { class: 'badges' },
        s.source === 'panel' ? h('span', { class: 'badge panel' }, 'set here') : s.source === 'environment' ? h('span', { class: 'badge' }, 'from environment') : null,
        s.live ? null : h('span', { class: 'badge restart' }, 'needs restart'))),
      input,
      h('p', { class: 'help' }, s.help, s.source === 'panel' ? [' ', h('button', { type: 'button', class: 'link', onclick: async () => {
        try { await api('/api/admin/config', { method: 'PUT', body: { changes: { [s.key]: null } } }); toast('Back to the environment value'); render(); } catch (e) { toast(e.message, true); }
      } }, 'Use the environment value')] : null));
  };
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const changes = {};
    for (const [key, { s, input }] of inputs) {
      const v = input.value;
      if (s.type === 'secret') { if (v !== '') changes[key] = v; }
      else if (v !== (s.value ?? '')) changes[key] = v;
    }
    if (!Object.keys(changes).length) return toast('Nothing to save');
    try {
      const r = await api('/api/admin/config', { method: 'PUT', body: { changes } });
      toast(r.restart ? 'Saved. Some changes apply after a restart.' : 'Saved. It applies now.');
      state.info = await api('/api/server/info');
      render();
    } catch (err) { toast(err.message, true); }
  } },
    groups.map((g) => h('div', { class: 'card' }, h('h2', null, g), list.filter((s) => s.group === g).map(make))),
    h('button', { class: 'primary', type: 'submit' }, 'Save changes'));
  return h('div', null,
    h('p', { class: 'muted' }, 'Changes are saved on the server in its data folder. A value set here wins over the environment; "Use the environment value" puts it back.'),
    form);
}

// ---- people -------------------------------------------------------------------------------------------------
async function people() {
  const { users } = await api('/api/admin/users');
  const act = (label, fn, cls = '') => h('button', { type: 'button', class: cls, onclick: async () => { try { await fn(); } catch (e) { toast(e.message, true); } } }, label);
  const patch = async (u, body, done) => { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body }); toast(done); render(); };
  const rows = users.map((u) => h('tr', null,
    h('td', null, h('strong', null, u.username), u.displayName !== u.username ? h('div', { class: 'muted small' }, u.displayName) : null,
      h('div', { class: 'badges', style: 'margin:4px 0 0' }, u.isAdmin ? h('span', { class: 'badge panel' }, 'administrator') : null, u.disabled ? h('span', { class: 'badge bad' }, 'switched off') : null)),
    h('td', { 'data-label': 'Joined' }, new Date(u.createdAt).toLocaleDateString()),
    h('td', { 'data-label': 'Last signed in' }, ago(u.lastSignIn)),
    h('td', { 'data-label': 'Messages' }, String(u.messages)),
    h('td', { 'data-label': 'Backups' }, u.backupBytes ? bytes(u.backupBytes) : '-'),
    h('td', { class: 'actions' },
      u.isAdmin ? act('Remove admin', () => patch(u, { isAdmin: false }, 'Done')) : act('Make admin', () => patch(u, { isAdmin: true }, 'Done')),
      u.disabled ? act('Switch on', () => patch(u, { disabled: false }, 'Switched on')) : act('Switch off', async () => {
        if (await confirmBox(`Switch off ${u.username}?`, 'They are signed out everywhere and cannot sign in until you switch the account on again. Their chats stay.', 'Switch off', true)) await patch(u, { disabled: true }, 'Switched off');
      }),
      act('Reset password', async () => {
        if (!(await confirmBox(`Reset ${u.username}'s password?`, 'They are signed out everywhere. You get a temporary password to pass on.', 'Reset', true))) return;
        const r = await api(`/api/admin/users/${u.id}/reset-password`, { method: 'POST' });
        await dialog('Temporary password', h('div', null, h('p', null, `Give this to ${u.username}. It is shown once.`), h('div', { class: 'secretbox' }, r.password)), [{ label: 'Done', value: true, class: 'primary' }]);
      }),
      act('Remove', async () => {
        if (await confirmBox(`Remove ${u.username}?`, 'The account, its messages, its chats memberships and its backups are deleted for good. Switch it off instead if you only want to stop them signing in.', 'Remove for good', true)) {
          await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); toast('Removed'); render();
        }
      }, 'danger'))));
  return h('div', { class: 'card' }, h('h2', null, `People (${users.length})`),
    h('div', { class: 'table-wrap' }, h('table', { class: 'stack' },
      h('thead', null, h('tr', null, ['Person', 'Joined', 'Last signed in', 'Messages', 'Backups', ''].map((t) => h('th', null, t)))),
      h('tbody', null, rows))));
}

// ---- invites ------------------------------------------------------------------------------------------------
async function invites() {
  const { invites: list } = await api('/api/admin/invites');
  const reg = state.info.registration === 'open'
    ? 'Registration is open, so people do not need a code. You can still make codes to connect a new person to you as a contact.'
    : state.info.houseKey ? 'A house key is set, so anyone who knows it can join. Codes are for one person each.' : 'People need a code to create an account.';
  return h('div', null,
    h('div', { class: 'card' }, h('h2', null, 'Invite someone'), h('p', { class: 'muted' }, reg),
      h('button', { class: 'primary', type: 'button', onclick: async () => {
        const r = await api('/api/admin/invites', { method: 'POST' });
        await dialog('Invite code', h('div', null, h('p', null, 'Give this code to one person. They enter it on the sign-up screen of their app.'), h('div', { class: 'secretbox' }, r.code)), [{ label: 'Done', value: true, class: 'primary' }]);
        render();
      } }, 'Create an invite code')),
    h('div', { class: 'card' }, h('h2', null, 'Codes'),
      list.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Code', 'Made by', 'Made', 'Used by', ''].map((t) => h('th', null, t)))),
        h('tbody', null, list.map((i) => h('tr', null,
          h('td', { class: 'mono' }, i.code), h('td', null, i.createdBy), h('td', null, ago(i.createdAt)),
          h('td', null, i.usedBy ? `${i.usedBy} (${ago(i.usedAt)})` : 'not used yet'),
          h('td', null, i.usedBy ? null : h('button', { type: 'button', class: 'danger', onclick: async () => { await api(`/api/admin/invites/${encodeURIComponent(i.code)}`, { method: 'DELETE' }); render(); } }, 'Revoke'))))))) : h('p', { class: 'muted' }, 'No codes yet.')));
}

// ---- backups -------------------------------------------------------------------------------------------------
async function backups() {
  const { backups: list, quotaMb } = await api('/api/admin/backups');
  return h('div', { class: 'card' }, h('h2', null, 'Backups kept for people'),
    h('p', { class: 'muted' }, `Each person may keep up to ${quotaMb} MB. Backups are sealed on the person's device; this server cannot read them.`),
    list.length ? list.map((u) => h('div', { style: 'margin-bottom:16px' }, h('h3', null, `${u.username} (${bytes(u.bytes)})`),
      h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, u.files.map((f) => h('tr', null,
        h('td', { class: 'mono' }, f.name), h('td', null, bytes(f.size)), h('td', null, when(f.modifiedAt)),
        h('td', null, h('button', { type: 'button', class: 'danger', onclick: async () => {
          if (await confirmBox('Delete this backup?', `${f.name} belongs to ${u.username}.`, 'Delete', true)) { await api(`/api/admin/backups/${u.userId}/${encodeURIComponent(f.name)}`, { method: 'DELETE' }); render(); }
        } }, 'Delete')))))))))
      : h('p', { class: 'muted' }, 'Nobody has stored a backup here yet.'));
}

// ---- activity ------------------------------------------------------------------------------------------------
async function activity() {
  const { log } = await api('/api/admin/log');
  return h('div', { class: 'card' }, h('h2', null, 'What administrators did'),
    log.length ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['When', 'Who', 'What', 'Detail'].map((t) => h('th', null, t)))),
      h('tbody', null, log.map((l) => h('tr', null, h('td', null, when(l.at)), h('td', null, l.who), h('td', null, l.action), h('td', null, l.detail)))))) : h('p', { class: 'muted' }, 'Nothing yet.'));
}

// ---- for client builders -----------------------------------------------------------------------------------------
async function apiDocs() {
  const { routes } = await api('/api/admin/routes');
  const info = await api('/api/server/info');
  return h('div', null,
    h('div', { class: 'card' }, h('h2', null, 'Build a client for this server'),
      h('p', null, 'Everything a client does goes through this server\'s HTTP and WebSocket API: sign-in, chats, messages, files, calls, backups. Ember and the Hearth web app are two clients of it. You can write another.'),
      h('p', null, 'Start with ', h('code', null, 'GET /api/server/info'), ' (no sign-in needed). It says what this server can do:'),
      h('pre', { class: 'card mono', style: 'overflow:auto;margin:0' }, JSON.stringify(info, null, 2)),
      h('p', { style: 'margin-top:12px' }, 'The written guide (authentication, the real-time channel, calls, backups, errors) is docs/API.md in the hearth-server repository.')),
    h('div', { class: 'card' }, h('h2', null, `Routes on this server (${routes.length})`),
      h('div', { class: 'routes' }, routes.map((r) => h('div', null, h('span', { class: 'method' }, r.method), h('span', { class: 'mono' }, r.url))))));
}

// ---- start -------------------------------------------------------------------------------------------------------
async function boot() {
  try {
    state.info = await api('/api/server/info');
  } catch (err) {
    app.replaceChildren(h('p', { class: 'boot' }, `Cannot reach the server: ${err.message}`));
    return;
  }
  document.title = `${state.info.name} admin`;
  if (state.info.setupNeeded) return authScreen(true);
  try {
    state.me = await api('/api/auth/me');
  } catch {
    return authScreen(false);
  }
  if (!state.me.admin) {
    app.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card' }, h('h2', null, 'Administrators only'), h('p', null, `${state.me.user.username} is not an administrator of this server.`),
      h('button', { type: 'button', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); boot(); } }, 'Sign out'))));
    return;
  }
  const wanted = location.hash.slice(1);
  if (TABS.some(([id]) => id === wanted)) state.tab = wanted;
  render();
}

window.addEventListener('hashchange', () => {
  const wanted = location.hash.slice(1);
  if (state.me && TABS.some(([id]) => id === wanted) && wanted !== state.tab) { state.tab = wanted; render(); }
});
boot();
