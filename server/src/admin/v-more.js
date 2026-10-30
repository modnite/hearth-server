import { icon } from './icons.js';
import { ago, api, bytes, button, confirmBox, copy, day, emptyState, h, megabytes, pageHead, pill, secretDialog, time, toast } from './ui.js';

// ---------------------------------------------------------------------------------------------- invites
export async function invites(ctx) {
  const { invites: list } = await api('/api/admin/invites');
  const info = (ctx.state.info = await api('/api/server/info'));
  ctx.setCounts({ invites: list.filter((i) => !i.usedBy).length });
  const create = async () => {
    try {
      const r = await api('/api/admin/invites', { method: 'POST' });
      await secretDialog({ title: 'Invite code', lead: 'Give this to one person. They enter it on the sign-up screen of their app. It works once.', value: r.code });
      ctx.render();
    } catch (e) { toast(e.message, true); }
  };

  return h('div', { class: 'page fade' },
    pageHead({ title: 'Invites', actions: [button('Joining settings', { onclick: () => ctx.go('settings', 'Joining') }), button('Create an invite code', { kind: 'primary', icon: 'plus', onclick: create })] }),
    h('div', { class: 'panel' },
      list.length ? h('div', { class: 'divided' }, list.map((i) => h('div', { class: 'invite' },
        h('span', { class: 'code-chip' }, i.code, button('', { icon: 'copy', small: true, kind: 'quiet', title: 'Copy the code', onclick: () => copy(i.code, 'Code copied') })),
        h('div', null,
          i.usedBy ? h('div', { class: 'state' }, pill('Used', 'good'), h('span', null, `by ${i.usedBy}`)) : h('div', { class: 'state' }, pill('Not used yet', 'accent')),
          h('div', { class: 'meta' }, i.usedBy ? `${ago(i.usedAt)}. Made by ${i.createdBy}.` : `Made by ${i.createdBy}, ${ago(i.createdAt)}`)),
        i.usedBy ? h('span') : button('Revoke', { small: true, kind: 'danger', onclick: async () => {
          if (!(await confirmBox({ title: 'Revoke this code?', text: 'Nobody will be able to use it.', yes: 'Revoke', danger: true }))) return;
          try { await api(`/api/admin/invites/${encodeURIComponent(i.code)}`, { method: 'DELETE' }); toast('Revoked'); ctx.render(); } catch (e) { toast(e.message, true); }
        } })))) : emptyState({ title: 'No invite codes', action: button('Create an invite code', { kind: 'primary', icon: 'plus', onclick: create }) })));
}

// ---------------------------------------------------------------------------------------------- backups
export async function backups(ctx) {
  const { backups: list, quotaMb } = await api('/api/admin/backups');
  const total = list.reduce((n, u) => n + u.bytes, 0);
  return h('div', { class: 'page fade' },
    pageHead({ title: 'Backups' }),
    list.length ? h('div', { class: 'panel divided' }, list.map((u) => {
      const pct = Math.min(100, (u.bytes / (quotaMb * 1048576)) * 100);
      return h('div', { class: 'person-usage' },
        h('div', { class: 'top' }, h('div', { class: 'grow' }, h('strong', null, u.username), h('div', { class: 'hint num' }, `${bytes(u.bytes)} of ${megabytes(quotaMb)} · ${u.files.length} ${u.files.length === 1 ? 'file' : 'files'}`))),
        h('div', { class: 'meter' + (pct > 90 ? ' hot' : ''), role: 'img', 'aria-label': `${Math.round(pct)}% of the space used` }, h('span', { style: `width:${Math.max(pct, 1)}%` })),
        h('div', { class: 'files' }, u.files.map((f) => h('div', { class: 'file' },
          h('span', { class: 'mono' }, f.name), h('span', { class: 'size num muted' }, bytes(f.size)), h('span', { class: 'date muted' }, new Date(f.modifiedAt).toLocaleString()),
          button('Delete', { small: true, kind: 'danger', onclick: async () => {
            if (!(await confirmBox({ title: 'Delete this backup?', text: `${f.name} belongs to ${u.username}. They may not be able to restore from it afterwards.`, yes: 'Delete', danger: true }))) return;
            try { await api(`/api/admin/backups/${u.userId}/${encodeURIComponent(f.name)}`, { method: 'DELETE' }); toast('Deleted'); ctx.render(); } catch (e) { toast(e.message, true); }
          } })))));
    })) : h('div', { class: 'panel' }, emptyState({ title: 'No backups' })),
    list.length ? h('p', { class: 'hint num' }, `${bytes(total)} in total across ${list.length} ${list.length === 1 ? 'person' : 'people'}.`) : null);
}

// ---------------------------------------------------------------------------------------------- activity
let labelOf = {};
const WHAT = {
  setup: ['check', 'good', (l) => `${l.who} created the administrator account`],
  setting: ['settings', '', (l) => `${l.who} changed “${labelOf[l.detail.split(' ')[0]] || l.detail.split(' ')[0]}”`, (l) => (l.detail.includes(' = ') ? l.detail.split(' = ').slice(1).join(' = ') : '')],
  disable: ['shieldoff', 'warn', (l) => `${l.who} switched off ${l.detail}`],
  enable: ['power', 'good', (l) => `${l.who} switched on ${l.detail}`],
  'make-admin': ['shield', 'accent', (l) => `${l.who} made ${l.detail} an administrator`],
  'remove-admin': ['user', '', (l) => `${l.who} removed ${l.detail} as administrator`],
  'reset-password': ['key', 'warn', (l) => `${l.who} reset the password of ${l.detail}`],
  'remove-user': ['trash', 'bad', (l) => `${l.who} removed the account ${l.detail}`],
  invite: ['invites', 'accent', (l) => `${l.who} made an invite code`],
  'revoke-invite': ['x', '', (l) => `${l.who} revoked an invite code`],
  'delete-backup': ['backups', 'bad', (l) => `${l.who} deleted the backup ${l.detail}`],
  restart: ['power', 'warn', (l) => `${l.who} restarted the server`],
};

export async function activity() {
  const [{ log }, { settings }] = await Promise.all([api('/api/admin/log'), api('/api/admin/config')]);
  labelOf = Object.fromEntries(settings.map((s) => [s.key, s.label]));
  const groups = [];
  for (const l of log) { const d = day(l.at); if (!groups.length || groups[groups.length - 1].d !== d) groups.push({ d, items: [] }); groups[groups.length - 1].items.push(l); }
  return h('div', { class: 'page fade' },
    pageHead({ title: 'Activity' }),
    log.length ? h('div', { class: 'panel timeline' }, groups.map((g) => [h('div', { class: 'day' }, g.d), g.items.map((l, i) => {
      const [ic, kind, text, extra] = WHAT[l.action] || ['info', '', (x) => `${x.who}: ${x.action}`];
      return h('div', { class: 'event' + (i === g.items.length - 1 ? ' last' : '') }, h('span', { class: 'ico ' + kind }, icon(ic, 'sm')), h('div', { class: 't' }, text(l), extra && extra(l) ? [h('div', { class: 'hint mono' }, extra(l))] : null), h('span', { class: 'when' }, time(l.at)));
    })])) : h('div', { class: 'panel' }, emptyState({ title: 'Nothing yet' })));
}

// ---------------------------------------------------------------------------------------------- for client builders
const CAP = { calls: 'Voice and video', push: 'Push notifications', backups: 'Backups kept here', browser: 'Browser proxy', twoStep: 'Two-step sign-in', friends: 'Friends and blocking' };
const AREAS = [
  ['Accounts and sign-in', /^\/api\/(auth|admin\/setup)/], ['Friends and blocks', /^\/api\/(contacts|friend-code|blocks|users)/], ['Chats and messages', /^\/api\/(rooms|messages|search|attachments|avatars|room-avatars|wallpapers|preview)/],
  ['Encryption', /^\/api\/e2ee/], ['Notifications', /^\/api\/(push|native)/], ['Backups', /^\/api\/backup/], ['Invites', /^\/api\/invites/], ['Administration', /^\/api\/admin/], ['Server', /^\/api\/(server|health)/],
];

export async function build() {
  const [{ routes }, info] = await Promise.all([api('/api/admin/routes'), api('/api/server/info')]);
  const json = JSON.stringify(info, null, 2);
  const grouped = AREAS.map(([name, re]) => [name, routes.filter((r) => re.test(r.url))]);
  const used = new Set(grouped.flatMap(([, r]) => r));
  const other = routes.filter((r) => !used.has(r));
  if (other.length) grouped.push(['Other', other]);
  const caps = Object.entries(info.features);

  return h('div', { class: 'page fade' },
    pageHead({ title: 'For client builders', actions: h('a', { class: 'btn', href: 'https://github.com/modnite/hearth-server/blob/main/docs/API.md', target: '_blank', rel: 'noopener' }, icon('code', 'sm'), 'Read the guide') }),
    h('section', null,
      h('div', { class: 'section-title' }, h('h2', null, 'Capabilities'), h('span', { class: 'meta mono' }, 'GET /api/server/info')),
      h('div', { class: 'caps', style: 'margin-bottom:16px' }, caps.map(([k, v]) => h('div', { class: 'cap' }, h('span', { class: 'dot ' + (v ? 'good' : 'off') }), CAP[k] || k))),
      h('div', { class: 'codeblock' }, button('Copy', { small: true, icon: 'copy', onclick: () => copy(json, 'Copied') }), h('pre', null, json))),
    h('section', null,
      h('div', { class: 'section-title' }, h('h2', null, 'Routes'), h('span', { class: 'meta num' }, `${routes.length} on this server`)),
      h('div', { class: 'panel divided' }, grouped.filter(([, r]) => r.length).map(([name, r]) => h('div', { class: 'route-group' }, h('h3', null, name, pill(String(r.length))),
        r.map((x) => h('div', { class: 'route' }, h('span', { class: 'm ' + x.method }, x.method), h('span', { class: 'u' }, x.url)))))))
  );
}
