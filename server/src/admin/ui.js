// The small UI kit every view uses. Everything is built with DOM calls and textContent (never innerHTML), so a name or a note that
// somebody typed can never run as markup.
import { icon } from './icons.js';

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') { // property by property through the CSSOM: the page's CSP forbids style attributes and cssText
      for (const decl of String(v).split(';')) { const i = decl.indexOf(':'); if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); }
    } else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export async function api(path, options = {}) {
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

// ---- formatting ---------------------------------------------------------------------------------------
export function bytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
export function megabytes(mb) { return mb >= 1024 ? `${+(mb / 1024).toFixed(2)} GB` : `${mb} MB`; }
export function ago(ms) {
  if (!ms) return 'never';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) { const d = Math.round(s / 86400); return d === 1 ? 'yesterday' : `${d} days ago`; }
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
export function day(ms) {
  const d = new Date(ms), t = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, t)) return 'Today';
  const y = new Date(t); y.setDate(t.getDate() - 1);
  if (same(d, y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}
export const time = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
export function duration(sec) {
  const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d} d ${hh} h` : hh ? `${hh} h ${m} min` : `${Math.max(1, m)} min`;
}
export const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

// ---- small parts --------------------------------------------------------------------------------------
export function avatar(user, cls = '') {
  return h('span', { class: 'avatar ' + cls, style: `background:${user.avatarColor || '#7c6cff'}`, 'aria-hidden': 'true' }, initials(user.displayName || user.username));
}
export const pill = (text, kind = '') => h('span', { class: 'pill ' + kind }, text);
export function button(label, { kind = '', icon: ic, onclick, small, title, disabled } = {}) {
  return h('button', { type: 'button', class: ['btn', kind, small ? 'sm' : '', label ? '' : 'icon-only'].filter(Boolean).join(' '), onclick, title, 'aria-label': label ? null : title, disabled }, ic ? icon(ic, small ? 'sm' : '') : null, label);
}

// ---- toast ---------------------------------------------------------------------------------------------
let toasts;
export function toast(text, bad = false) {
  if (!toasts) { toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toasts); }
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, icon(bad ? 'alert' : 'check', 'sm'), text);
  toasts.append(t);
  setTimeout(() => t.remove(), bad ? 6500 : 3200);
}

export async function copy(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('Copy is not allowed here. Select it and copy by hand.', true); }
}

// ---- dialogs ---------------------------------------------------------------------------------------------
function openDialog(dlg) {
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // a click on the backdrop
  dlg.showModal();
  return dlg;
}

/** A centred dialog. Resolves with the value of the button pressed, or null if it was dismissed. */
export function modal({ title, body, buttons }) {
  return new Promise((resolve) => {
    let result = null;
    const dlg = h('dialog', { class: 'modal', 'aria-labelledby': 'dlg-t' },
      h('div', { class: 'sheet' }, h('h2', { id: 'dlg-t' }, title), h('div', { class: 'body' }, body),
        h('div', { class: 'actions' }, buttons.map((b) => h('button', { type: 'button', class: 'btn ' + (b.kind || ''), onclick: () => { result = b.value; dlg.close(); } }, b.label)))));
    dlg.addEventListener('close', () => resolve(result));
    openDialog(dlg);
    dlg.querySelector('.btn.primary, .btn.danger.solid')?.focus();
  });
}

export async function confirmBox({ title, text, yes = 'Yes', danger = false }) {
  return (await modal({ title, body: h('p', null, text), buttons: [{ label: 'Cancel', value: false }, { label: yes, value: true, kind: danger ? 'danger solid' : 'primary' }] })) === true;
}

/** Shows a value the server will not show again (a temporary password, an invite code). */
export function secretDialog({ title, lead, value }) {
  return modal({
    title,
    body: [h('p', null, lead), h('div', { class: 'secretbox' }, h('span', { style: 'user-select:all' }, value), button('', { icon: 'copy', title: 'Copy', kind: 'quiet', onclick: () => copy(value) }))],
    buttons: [{ label: 'Done', value: true, kind: 'primary' }],
  });
}

/** A side panel (a bottom sheet on phones). `build(close)` returns its content. */
export function drawer(build) {
  const dlg = h('dialog', { class: 'drawer', 'aria-label': 'Details' });
  const close = () => dlg.close();
  dlg.append(h('div', { class: 'drawer-panel' }, build(close)));
  openDialog(dlg);
  return { close, el: dlg };
}

// ---- theme ----------------------------------------------------------------------------------------------------
export const theme = {
  get() { try { return localStorage.getItem('hearth-admin-theme'); } catch { return null; } },
  apply() { const t = theme.get(); if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; },
  isDark() { const t = theme.get(); return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; },
  toggle() {
    const next = theme.isDark() ? 'light' : 'dark';
    try { localStorage.setItem('hearth-admin-theme', next); } catch { /* private mode: it just will not be remembered */ }
    theme.apply();
  },
};

export function skeleton(rows = 4) {
  return h('div', { class: 'panel' }, Array.from({ length: rows }, (_, i) => h('div', { style: 'padding:16px 24px;border-top:' + (i ? '1px solid var(--line)' : '0') }, h('div', { class: 'skel', style: `height:14px;width:${40 + ((i * 17) % 40)}%` }), h('div', { class: 'skel', style: 'height:11px;width:30%;margin-top:10px;opacity:.7' }))));
}

export function pageHead({ title, actions }) {
  return h('header', { class: 'page-head' }, h('h1', null, title), actions ? h('div', { class: 'page-actions' }, actions) : null);
}

export function emptyState({ title, action }) {
  return h('div', { class: 'empty' }, h('strong', null, title), action || null);
}
