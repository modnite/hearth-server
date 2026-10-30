// The Hearth server admin panel: sign-in, the shell, and the router. Plain ES modules, no build step, no outside requests.
import { icon, mark } from './icons.js';
import { activity, backups, build, invites } from './v-more.js';
import { overview } from './v-overview.js';
import { people } from './v-people.js';
import { settings } from './v-settings.js';
import { api, avatar, button, h, modal, skeleton, theme } from './ui.js';

theme.apply();

const app = document.getElementById('app');
const state = { info: null, me: null, tab: 'overview', counts: { users: null, invites: null } };

const TABS = [
  { id: 'overview', label: 'Overview', ico: 'overview', group: 'Server', view: overview },
  { id: 'settings', label: 'Settings', ico: 'settings', group: 'Server', view: settings },
  { id: 'people', label: 'People', ico: 'people', group: 'People', view: people, count: 'users' },
  { id: 'invites', label: 'Invites', ico: 'invites', group: 'People', view: invites, count: 'invites' },
  { id: 'backups', label: 'Backups', ico: 'backups', group: 'Operate', view: backups },
  { id: 'activity', label: 'Activity', ico: 'activity', group: 'Operate', view: activity },
  { id: 'build', label: 'For client builders', ico: 'code', group: 'Operate', view: build },
];
const byId = (id) => TABS.find((t) => t.id === id);

// ---------------------------------------------------------------------------------------------- sign-in and first run
function gate(setup) {
  const user = h('input', { class: 'input', id: 'u', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const pass = h('input', { class: 'input', id: 'p', type: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true });
  const again = h('input', { class: 'input', id: 'p2', type: 'password', autocomplete: 'new-password', required: true });
  const code = h('input', { class: 'input mono', id: 'c', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123 456' });
  const codeField = h('div', { class: 'field', hidden: true }, h('label', { class: 'label', for: 'c' }, 'Two-step code'), code, h('span', { class: 'hint' }, 'From your authenticator app.'));
  const msg = h('div', { class: 'error-text', role: 'alert', hidden: true });
  const strength = h('div', { class: 'strength', 'data-s': '0', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'));
  const submit = h('button', { type: 'submit', class: 'btn primary wide' }, setup ? 'Create administrator' : 'Sign in');
  const reveal = h('button', { type: 'button', class: 'btn quiet sm icon-only reveal', title: 'Show password', 'aria-label': 'Show password', onclick: () => { const on = pass.type === 'password'; pass.type = on ? 'text' : 'password'; reveal.replaceChildren(icon(on ? 'eyeoff' : 'eye', 'sm')); } }, icon('eye', 'sm'));

  const score = (v) => (v.length >= 8) + (v.length >= 12) + (/[A-Z]/.test(v) && /[a-z]/.test(v)) + (/\d/.test(v) || /[^A-Za-z0-9]/.test(v));
  if (setup) pass.addEventListener('input', () => { strength.dataset.s = String(Math.min(4, pass.value ? Math.max(1, score(pass.value)) : 0)); });
  const fail = (text, el) => { msg.replaceChildren(icon('alert', 'sm'), text); msg.hidden = false; if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); } };

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
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'p' }, 'Password'), h('div', { class: 'input-wrap' }, pass, reveal), setup ? strength : null),
    setup ? h('div', { class: 'field' }, h('label', { class: 'label', for: 'p2' }, 'Repeat the password'), again) : null,
    codeField, msg, submit);

  app.replaceChildren(h('main', { class: 'gate' }, h('div', { class: 'gate-card' },
    h('div', { class: 'brand' }, mark(), h('div', { class: 'txt' }, h('div', { class: 'name' }, state.info.name))),
    h('h1', null, setup ? 'Create the administrator' : 'Sign in'), form)));
  user.focus();
}

// ---------------------------------------------------------------------------------------------- shell
let content, navEl, tabbarEl, leaving = [];

function navLinks(kind) {
  const link = (t) => h('a', { href: `#${t.id}`, 'aria-current': state.tab === t.id ? 'page' : false, 'data-tab': t.id },
    icon(t.ico, kind === 'tabbar' ? '' : 'lg'), h('span', null, kind === 'tabbar' ? t.label.split(' ')[0] : t.label),
    kind !== 'tabbar' && t.count && state.counts[t.count] != null ? h('span', { class: 'count num' }, String(state.counts[t.count])) : null);
  if (kind === 'tabbar') return ['overview', 'people', 'invites', 'settings'].map((id) => link(byId(id)));
  const out = [];
  let g = '';
  for (const t of TABS) { if (t.group !== g) { g = t.group; out.push(h('div', { class: 'group' }, g)); } out.push(link(t)); }
  return out;
}

async function signOut() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* the cookie goes away either way */ }
  await boot();
}

function moreSheet() {
  const row = (ico, label, fn, extra) => h('button', { type: 'button', class: 'act', onclick: () => { document.querySelector('dialog.modal')?.close(); fn(); } }, icon(ico), h('span', null, h('span', { class: 't' }, label), extra ? h('span', { class: 'd' }, extra) : null));
  modal({
    title: 'More',
    body: h('div', { class: 'acts' }, h('div', { class: 'stack' },
      row('backups', 'Backups', () => { location.hash = 'backups'; }), row('activity', 'Activity', () => { location.hash = 'activity'; }), row('code', 'For client builders', () => { location.hash = 'build'; }),
      row(theme.isDark() ? 'sun' : 'moon', theme.isDark() ? 'Light theme' : 'Dark theme', () => theme.toggle()),
      row('logout', 'Sign out', signOut, state.me.user.username))),
    buttons: [{ label: 'Close', value: null }],
  });
}

function themeButton() {
  const b = h('button', { type: 'button', class: 'btn', title: 'Switch between light and dark', 'aria-label': 'Switch between light and dark', onclick: () => { theme.toggle(); document.querySelectorAll('[data-theme-btn]').forEach((x) => x.replaceChildren(icon(theme.isDark() ? 'sun' : 'moon', 'sm'))); } }, icon(theme.isDark() ? 'sun' : 'moon', 'sm'));
  b.dataset.themeBtn = '1';
  return b;
}

function buildShell() {
  const me = state.me.user;
  content = h('div', { id: 'content' });
  navEl = h('nav', { class: 'nav', 'aria-label': 'Sections' }, navLinks('rail'));
  tabbarEl = h('nav', { class: 'tabbar', 'aria-label': 'Sections' }, navLinks('tabbar'), h('button', { type: 'button', onclick: moreSheet }, icon('more'), h('span', null, 'More')));
  app.replaceChildren(
    h('a', { class: 'skip', href: '#main', onclick: (e) => { e.preventDefault(); document.getElementById('main').focus(); } }, 'Skip to the content'),
    h('div', { class: 'topbar' }, h('div', { class: 'brand' }, mark(), h('div', { class: 'txt' }, h('div', { class: 'name' }, state.info.name))), h('div', { class: 'foot-actions' }, themeButton())),
    h('div', { class: 'app' },
      h('aside', { class: 'rail' },
        h('div', { class: 'brand' }, mark(), h('div', { class: 'txt' }, h('div', { class: 'name' }, state.info.name), h('div', { class: 'sub num' }, `Admin · v${state.info.version}`))),
        navEl,
        h('div', { class: 'rail-foot' },
          h('div', { class: 'me' }, avatar({ displayName: me.displayName, username: me.username, avatarColor: me.avatarColor }), h('div', { class: 'who' }, h('strong', null, me.displayName), h('span', null, 'Administrator'))),
          h('div', { class: 'foot-actions' }, themeButton(), h('button', { type: 'button', class: 'btn', onclick: signOut }, icon('logout', 'sm'), 'Sign out')))),
      h('main', { class: 'main', id: 'main', tabindex: '-1' }, content)),
    tabbarEl);
}

function refreshNav() {
  if (!navEl) return;
  navEl.replaceChildren(...navLinks('rail'));
  for (const a of tabbarEl.querySelectorAll('a')) { if (a.dataset.tab === state.tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
}

const ctx = {
  state,
  focusGroup: null,
  go(tab, group) { ctx.focusGroup = group || null; if (location.hash === `#${tab}`) render(); else location.hash = tab; },
  render: () => render(true),
  setCounts(c) { Object.assign(state.counts, c); refreshNav(); },
  onLeave(fn) { leaving.push(fn); },
};

let renderToken = 0;
async function render(keepScroll = false) {
  const token = ++renderToken;
  const y = keepScroll ? window.scrollY : 0;
  for (const fn of leaving.splice(0)) { try { fn(); } catch { /* a view's cleanup must not stop the next view */ } }
  refreshNav();
  const tab = byId(state.tab) || TABS[0];
  document.title = `${tab.label} · ${state.info.name}`;
  if (!keepScroll || !content.firstChild) content.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'skel', style: 'height:34px;width:220px;margin-bottom:28px' }), skeleton(5)));
  try {
    const el = await tab.view(ctx);
    if (token !== renderToken) return;
    content.replaceChildren(el);
    window.scrollTo(0, y);
  } catch (err) {
    if (token !== renderToken) return;
    if (err.status === 401 || err.status === 403) return boot();
    content.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'banner bad', role: 'alert' }, icon('alert'), h('div', { class: 'grow' }, err.message), button('Try again', { small: true, onclick: () => render() }))));
  }
}

function route() {
  const [id, group] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (byId(id)) { state.tab = id; if (group) ctx.focusGroup = group; render(); return true; }
  return false;
}
window.addEventListener('hashchange', () => { if (state.me) route(); });

// the overview stays current while it is on screen
setInterval(() => { if (state.me && state.tab === 'overview' && !document.hidden && !document.querySelector('dialog[open]')) render(true); }, 30000);

// ---------------------------------------------------------------------------------------------- start
async function boot() {
  state.me = null; navEl = null;
  try { state.info = await api('/api/server/info'); } catch (err) {
    app.replaceChildren(h('div', { class: 'gate-form', style: 'min-height:100vh' }, h('div', { class: 'gate-card' }, h('h1', null, 'Cannot reach the server'), h('p', { class: 'lead' }, err.message), button('Try again', { kind: 'primary', onclick: boot }))));
    return;
  }
  if (state.info.setupNeeded) return gate(true);
  try { state.me = await api('/api/auth/me'); } catch { return gate(false); }
  if (!state.me.admin) {
    app.replaceChildren(h('div', { class: 'gate-form', style: 'min-height:100vh' }, h('div', { class: 'gate-card' }, h('h1', null, 'Administrators only'), h('p', { class: 'lead' }, `${state.me.user.username} is not an administrator of this server.`), button('Sign out', { onclick: signOut }))));
    return;
  }
  buildShell();
  if (!route()) render();
}

boot();
