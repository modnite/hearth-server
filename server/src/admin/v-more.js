import { ago, api, bytes, button, confirmBox, copy, day, h, megabytes, pageHead, pill, secretDialog, time, toast } from './ui.js';

const table = (heads, rows, rightFrom = 99, widths = null) => h('div', { class: 'table-wrap' }, h('table', { class: widths ? 'fixed' : '' },
  widths ? h('colgroup', null, widths.map((w) => h('col', { style: `width:${w}` }))) : null,
  h('thead', null, h('tr', null, heads.map((t, i) => h('th', { class: i >= rightFrom ? 'r' : '' }, t)))), h('tbody', null, rows)));

// ---------------------------------------------------------------------------------------------- invites
export async function invites(ctx) {
  const { invites: list } = await api('/api/admin/invites');
  ctx.setCounts({ invites: list.filter((i) => !i.usedBy).length });

  const create = async () => {
    try {
      const r = await api('/api/admin/invites', { method: 'POST' });
      await secretDialog({ title: 'Invite code', lead: 'Works once.', value: r.code });
      ctx.render();
    } catch (e) { toast(e.message, true); }
  };

  return h('div', null,
    pageHead({ title: 'Invites', actions: [button('Joining settings', { onclick: () => ctx.go('settings', 'Joining') }), button('Create invite code', { kind: 'primary', onclick: create })] }),
    h('div', { class: 'panel' }, list.length
      ? table(['Code', 'Status', 'Made by', 'Made', ''], list.map((i) => h('tr', null,
        h('td', null, h('code', null, i.code), ' ', button('Copy', { small: true, onclick: () => copy(i.code, 'Code copied') })),
        h('td', null, i.usedBy ? ['Used by ', i.usedBy, ' ', h('span', { class: 'muted' }, ago(i.usedAt))] : 'Unused'),
        h('td', null, i.createdBy), h('td', null, ago(i.createdAt)),
        h('td', { class: 'actions' }, i.usedBy ? null : button('Revoke', { small: true, kind: 'danger', onclick: async () => {
          if (!(await confirmBox({ title: 'Revoke this code', text: 'Nobody will be able to use it.', yes: 'Revoke', danger: true }))) return;
          try { await api(`/api/admin/invites/${encodeURIComponent(i.code)}`, { method: 'DELETE' }); toast('Revoked'); ctx.render(); } catch (e) { toast(e.message, true); }
        } })))))
      : h('div', { class: 'empty' }, 'No invite codes')));
}

// ---------------------------------------------------------------------------------------------- backups
export async function backups(ctx) {
  const { backups: list, quotaMb } = await api('/api/admin/backups');
  const total = list.reduce((n, u) => n + u.bytes, 0);
  return h('div', null,
    pageHead({ title: 'Backups' }),
    list.length ? list.map((u) => {
      const pct = Math.min(100, (u.bytes / (quotaMb * 1048576)) * 100);
      return h('div', { class: 'panel' },
        h('div', { class: 'ph' }, u.username, h('span', { class: 'meta num' }, `${bytes(u.bytes)} of ${megabytes(quotaMb)}`)),
        h('div', { class: 'pad' }, h('div', { class: 'meter' + (pct > 90 ? ' hot' : ''), role: 'img', 'aria-label': `${Math.round(pct)}% used` }, h('span', { style: `width:${Math.max(pct, 1)}%` }))),
        table(['File', 'Size', 'Made', ''], u.files.map((f) => h('tr', null,
          h('td', null, h('code', null, f.name)), h('td', { class: 'num' }, bytes(f.size)), h('td', { class: 'num' }, new Date(f.modifiedAt).toLocaleString()),
          h('td', { class: 'actions' }, button('Delete', { small: true, kind: 'danger', onclick: async () => {
            if (!(await confirmBox({ title: 'Delete this backup', text: `${f.name} belongs to ${u.username}. They may not be able to restore from it afterwards.`, yes: 'Delete', danger: true }))) return;
            try { await api(`/api/admin/backups/${u.userId}/${encodeURIComponent(f.name)}`, { method: 'DELETE' }); toast('Deleted'); ctx.render(); } catch (e) { toast(e.message, true); }
          } })))), 99, ['46%', '14%', '28%', '12%']));
    }) : h('div', { class: 'panel' }, h('div', { class: 'empty' }, 'No backups')),
    list.length ? h('p', { class: 'hint num' }, `${bytes(total)} in total, ${list.length} ${list.length === 1 ? 'person' : 'people'}`) : null);
}

// ---------------------------------------------------------------------------------------------- activity
let labelOf = {};
const WHAT = {
  setup: (l) => 'Created the administrator account',
  setting: (l) => `Changed “${labelOf[l.detail.split(' ')[0]] || l.detail.split(' ')[0]}”`,
  disable: (l) => `Switched off ${l.detail}`, enable: (l) => `Switched on ${l.detail}`,
  'make-admin': (l) => `Made ${l.detail} an administrator`, 'remove-admin': (l) => `Removed ${l.detail} as administrator`,
  'reset-password': (l) => `Reset the password of ${l.detail}`, 'remove-user': (l) => `Removed the account ${l.detail}`,
  invite: () => 'Made an invite code', 'revoke-invite': () => 'Revoked an invite code',
  'delete-backup': (l) => `Deleted the backup ${l.detail}`, restart: () => 'Restarted the server',
  'resolve-crash': () => 'Marked a crash as fixed', 'reopen-crash': () => 'Reopened a crash', 'delete-crash': () => 'Deleted a crash',
};
const valueOf = (l) => (l.action === 'setting' && l.detail.includes(' = ') ? l.detail.split(' = ').slice(1).join(' = ') : '');

export async function activity() {
  const [{ log }, { settings }] = await Promise.all([api('/api/admin/log'), api('/api/admin/config')]);
  labelOf = Object.fromEntries(settings.map((s) => [s.key, s.label]));
  return h('div', null,
    pageHead({ title: 'Activity' }),
    h('div', { class: 'panel' }, log.length
      ? table(['When', 'Who', 'What', 'Value'], log.map((l) => h('tr', null,
        h('td', { class: 'num' }, `${day(l.at)} ${time(l.at)}`), h('td', null, l.who), h('td', null, (WHAT[l.action] || ((x) => x.action))(l)), h('td', null, h('code', null, valueOf(l))))))
      : h('div', { class: 'empty' }, 'Nothing yet')));
}

// ---------------------------------------------------------------------------------------------- for client builders
const CAP = { calls: 'Voice and video', push: 'Push notifications', backups: 'Backups kept here', browser: 'Browser proxy', twoStep: 'Two-step sign-in', friends: 'Friends and blocking', crashReports: 'Crash reports' };
const AREAS = [
  ['Accounts and sign-in', /^\/api\/(auth|admin\/setup)/], ['Friends and blocks', /^\/api\/(contacts|friend-code|blocks|users)/], ['Chats and messages', /^\/api\/(rooms|messages|search|attachments|avatars|room-avatars|wallpapers|preview)/],
  ['Encryption', /^\/api\/e2ee/], ['Notifications', /^\/api\/(push|native)/], ['Backups', /^\/api\/backup/], ['Crash reports', /^\/api\/crash-reports/], ['Invites', /^\/api\/invites/], ['Administration', /^\/api\/admin/], ['Server', /^\/api\/(server|health)/],
];

export async function build() {
  const [{ routes }, info] = await Promise.all([api('/api/admin/routes'), api('/api/server/info')]);
  const json = JSON.stringify(info, null, 2);
  const grouped = AREAS.map(([name, re]) => [name, routes.filter((r) => re.test(r.url))]);
  const used = new Set(grouped.flatMap(([, r]) => r));
  const other = routes.filter((r) => !used.has(r));
  if (other.length) grouped.push(['Other', other]);

  return h('div', null,
    pageHead({ title: 'For client builders', actions: h('a', { class: 'btn', href: 'https://github.com/modnite/hearth-server/blob/main/docs/API.md', target: '_blank', rel: 'noopener' }, 'API guide') }),
    h('div', { class: 'panel' }, h('div', { class: 'ph' }, 'Capabilities', h('span', { class: 'meta mono' }, 'GET /api/server/info')),
      table(['Feature', 'Available'], Object.entries(info.features).map(([k, v]) => h('tr', null, h('td', null, CAP[k] || k), h('td', null, v ? 'Yes' : 'No'))))),
    h('div', { class: 'panel codeblock' }, h('div', { class: 'ph' }, 'Server info', button('Copy', { small: true, onclick: () => copy(json, 'Copied') })), h('pre', null, json)),
    h('div', { class: 'panel' }, h('div', { class: 'ph' }, 'Routes', h('span', { class: 'meta num' }, `${routes.length}`)),
      grouped.filter(([, r]) => r.length).map(([name, r]) => h('div', { class: 'route-group' }, h('h3', null, `${name} (${r.length})`),
        r.map((x) => h('div', { class: 'route' }, h('span', { class: 'm' }, x.method), h('span', { class: 'u' }, x.url)))))));
}
