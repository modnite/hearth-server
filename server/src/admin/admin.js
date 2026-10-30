// The Hearth server administration page: sign-in, the shell (header bar and menu) and the router. Plain ES modules, no build step,
// no outside requests.
import { activity, backups, build, invites } from './v-more.js';
import { overview } from './v-overview.js';
import { people } from './v-people.js';
import { settings } from './v-settings.js';
import { icon } from './icons.js';
import { api, button, h, skeleton, theme } from './ui.js';

theme.apply();

const app = document.getElementById('app');
const state = { info: null, me: null, tab: 'overview', counts: { users: null, invites: null } };

const TABS = [
  { id: 'overview', ico: 'overview', label: 'Overview', group: 'Server', view: overview },
  { id: 'settings', ico: 'settings', label: 'Settings', group: 'Server', view: settings },
  { id: 'people', ico: 'people', label: 'People', group: 'People', view: people, count: 'users' },
  { id: 'invites', ico: 'invites', label: 'Invites', group: 'People', view: invites, count: 'invites' },
  { id: 'backups', ico: 'backups', label: 'Backups', group: 'Operate', view: backups },
  { id: 'activity', ico: 'activity', label: 'Activity', group: 'Operate', view: activity },
  { id: 'build', ico: 'code', label: 'For client builders', group: 'Operate', view: build },
];
const byId = (id) => TABS.find((t) => t.id === id);

// ---------------------------------------------------------------------------------------------- sign-in and first run
function gate(setup) {
  const user = h('input', { class: 'input', id: 'u', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const pass = h('input', { class: 'input', id: 'p', type: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true });
  const again = h('input', { class: 'input', id: 'p2', type: 'password', autocomplete: 'new-password', required: true });
  const code = h('input', { class: 'input mono', id: 'c', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123 456' });
  const codeField = h('div', { class: 'field', hidden: true }, h('label', { class: 'label', for: 'c' }, 'Two-step code'), code);
  const msg = h('div', { class: 'error-text', role: 'alert', hidden: true });
  const strength = h('div', { class: 'strength', 'data-s': '0', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'));
  const submit = h('button', { type: 'submit', class: 'btn primary' }, setup ? 'Create administrator' : 'Sign in');

  const score = (v) => (v.length >= 8) + (v.length >= 12) + (/[A-Z]/.test(v) && /[a-z]/.test(v)) + (/\d/.test(v) || /[^A-Za-z0-9]/.test(v));
  if (setup) pass.addEventListener('input', () => { strength.dataset.s = String(Math.min(4, pass.value ? Math.max(1, score(pass.value)) : 0)); });
  const fail = (text, el) => { msg.replaceChildren(text); msg.hidden = false; if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); } };

  const form = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); msg.hidden = true; [user, pass, again, code].forEach((x) => x.removeAttribute('aria-invalid'));
    if (!user.value.trim()) return fail('Enter a username.', user);
    if (!pass.value) return fail('Enter a password.', pass);
    if (setup && pass.value.length < 8) return fail('Use 8 or more characters.', pass);
    if (setup && pass.value !== again.value) return fail('The two passwords are not the same.', again);
    submit.disabled = true;
    try {
      if (setup) await api('/api/admin/setup', { method: 'POST', body: { username: user.value.trim(), password: pass.value } });
      else await api('/api/auth/login', { method: 'POST', body: { username: user.value.trim(), password: pass.value, code: code.value.trim() || undefined } });
      await boot();
    } catch (err) {
      submit.disabled = false;
      if (err.message.includes('two-step')) { codeField.hidden = false; code.focus(); }
      fail(err.message);
    }
  } },
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'u' }, 'Username'), user),
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'p' }, 'Password'), pass, setup ? strength : null),
    setup ? h('div', { class: 'field' }, h('label', { class: 'label', for: 'p2' }, 'Repeat the password'), again) : null,
    codeField, msg, submit);

  app.replaceChildren(h('main', { class: 'gate' }, h('div', { class: 'gate-card panel' },
    h('div', { class: 'ph' }, state.info.name), form)));
  user.focus();
}

function plainScreen(title, text, action) {
  app.replaceChildren(h('main', { class: 'gate' }, h('div', { class: 'gate-card panel' },
    h('div', { class: 'ph' }, title), h('div', { class: 'pad', style: 'display:grid;gap:12px' }, text ? h('p', null, text) : null, action))));
}

// ---------------------------------------------------------------------------------------------- shell
let content, navEl, sideEl, leaving = [], after = [];

function navLinks() {
  const out = [];
  let g = '';
  for (const t of TABS) {
    if (t.group !== g) { g = t.group; out.push(h('div', { class: 'group' }, g)); }
    out.push(h('a', { href: `#${t.id}`, 'aria-current': state.tab === t.id ? 'page' : false, 'data-tab': t.id, onclick: () => sideEl.classList.remove('open') },
      icon(t.ico), t.label, t.count && state.counts[t.count] != null ? h('span', { class: 'count num' }, String(state.counts[t.count])) : null));
  }
  return out;
}

async function signOut() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* the cookie goes away either way */ }
  await boot();
}

function buildShell() {
  const me = state.me.user;
  content = h('div', { id: 'content', class: 'page' });
  navEl = h('nav', { 'aria-label': 'Sections' }, navLinks());
  sideEl = h('aside', { class: 'side' }, navEl);
  const themeBtn = h('button', { type: 'button', class: 'btn', title: 'Switch between light and dark', onclick: () => { theme.toggle(); themeBtn.textContent = theme.isDark() ? 'Light' : 'Dark'; } }, theme.isDark() ? 'Light' : 'Dark');
  app.replaceChildren(
    h('a', { class: 'skip', href: '#main', onclick: (e) => { e.preventDefault(); document.getElementById('main').focus(); } }, 'Skip to the content'),
    h('header', { class: 'hdr' },
      h('button', { type: 'button', class: 'btn menu', 'aria-label': 'Menu', onclick: () => sideEl.classList.toggle('open') }, 'Menu'),
      h('span', { class: 'name' }, state.info.name), h('span', { class: 'ver' }, `v${state.info.version}`),
      h('span', { class: 'sp' }), h('span', { class: 'who' }, me.username), themeBtn, h('button', { type: 'button', class: 'btn', onclick: signOut }, 'Sign out')),
    h('div', { class: 'layout' }, sideEl, h('main', { class: 'main', id: 'main', tabindex: '-1' }, content)));
}

function refreshNav() {
  if (!navEl) return;
  navEl.replaceChildren(...navLinks());
}

const ctx = {
  state,
  focusGroup: null,
  go(tab, group) { ctx.focusGroup = group || null; if (location.hash === `#${tab}`) render(); else location.hash = tab; },
  render: () => render(true),
  setCounts(c) { Object.assign(state.counts, c); refreshNav(); },
  onLeave(fn) { leaving.push(fn); },
  afterRender(fn) { after.push(fn); },
};

let renderToken = 0;
async function render(keepScroll = false) {
  const token = ++renderToken;
  const y = keepScroll ? window.scrollY : 0;
  for (const fn of leaving.splice(0)) { try { fn(); } catch { /* a view's cleanup must not stop the next view */ } }
  after = [];
  refreshNav();
  const tab = byId(state.tab) || TABS[0];
  document.title = `${tab.label} · ${state.info.name}`;
  if (!keepScroll || !content.firstChild) content.replaceChildren(skeleton(4));
  try {
    const el = await tab.view(ctx);
    if (token !== renderToken) return;
    content.replaceChildren(...el.childNodes);
    window.scrollTo(0, y);
    for (const fn of after.splice(0)) { try { fn(); } catch { /* a view's tidy-up must not break the page */ } }
  } catch (err) {
    if (token !== renderToken) return;
    if (err.status === 401 || err.status === 403) return boot();
    content.replaceChildren(h('div', { class: 'banner bad', role: 'alert' }, h('div', { class: 'grow' }, err.message), button('Try again', { small: true, onclick: () => render() })));
  }
}

function route() {
  const [id, group] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (byId(id)) { state.tab = id; if (group) ctx.focusGroup = group; render(); return true; }
  return false;
}
window.addEventListener('hashchange', () => { if (state.me) route(); });

// the overview stays current while it is on screen
setInterval(() => { if (state.me && state.tab === 'overview' && !document.hidden && !document.querySelector('dialog[open]')) render(true); }, 10000);

// ---------------------------------------------------------------------------------------------- start
async function boot() {
  state.me = null; navEl = null;
  try { state.info = await api('/api/server/info'); } catch (err) {
    plainScreen('Cannot reach the server', err.message, button('Try again', { kind: 'primary', onclick: boot }));
    return;
  }
  if (state.info.setupNeeded) return gate(true);
  try { state.me = await api('/api/auth/me'); } catch { return gate(false); }
  if (!state.me.admin) {
    plainScreen('Administrators only', `${state.me.user.username} is not an administrator of this server.`, button('Sign out', { onclick: signOut }));
    return;
  }
  buildShell();
  if (!route()) render();
}

boot();
