import { api, bytes, button, confirmBox, copy, duration, h, pageHead, pill, toast } from './ui.js';

const DISMISSED = 'hearth-admin-checklist-dismissed';
const dismissed = () => { try { return localStorage.getItem(DISMISSED) === '1'; } catch { return false; } };

const kv = (rows) => h('div', { class: 'kv' }, rows.flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', null, v)]));

export async function overview(ctx) {
  const [s, info] = await Promise.all([api('/api/admin/status'), api('/api/server/info')]);
  ctx.state.info = info;
  ctx.setCounts({ users: s.counts.users, invites: s.counts.openInvites });
  const origin = location.origin;

  const banners = [];
  if (!s.secrets.sessionSecretChanged) banners.push({ text: 'SESSION_SECRET is still the built-in default. Set a long random value in the server environment.' });
  if (s.calls.configured && !s.calls.reachable) banners.push({ text: 'LiveKit is set up, but this server cannot reach it. Calls will fail.', action: ['Calls settings', () => ctx.go('settings', 'Calls')] });
  if (info.registration === 'open') banners.push({ text: 'Anyone who can reach this server can create an account.', action: ['Change', () => ctx.go('settings', 'Joining')] });

  const steps = [
    { done: true, t: 'Create the administrator' },
    { done: info.name !== 'Hearth', t: 'Name the server', go: ['Settings', () => ctx.go('settings', 'Server')] },
    { done: s.counts.users > 1, t: 'Invite the first person', go: ['Invites', () => ctx.go('invites')] },
    { done: s.calls.configured, t: 'Set up voice and video', go: ['Calls settings', () => ctx.go('settings', 'Calls')] },
    { done: s.push.configured, t: 'Turn on notifications', go: ['Notification settings', () => ctx.go('settings', 'Notifications')] },
  ];
  const doneCount = steps.filter((x) => x.done).length;
  const showList = !dismissed() && doneCount < steps.length;

  const total = s.storageBytes.uploads + s.storageBytes.backups + s.storageBytes.database;
  const parts = [['Shared files', s.storageBytes.uploads, '#5a7fa8'], ['Backups', s.storageBytes.backups, '#8a8f94'], ['Database', s.storageBytes.database, '#b0a37a']];

  const status = (label, on) => h('span', null, h('span', { class: 'dot' + (on === true ? ' good' : on === 'bad' ? ' bad' : '') }), label);

  return h('div', null,
    pageHead({ title: info.name }),
    banners.length ? h('div', { class: 'banners' }, banners.map((b) => h('div', { class: 'banner', role: 'note' }, h('div', { class: 'grow' }, b.text), b.action ? button(b.action[0], { small: true, onclick: b.action[1] }) : null))) : null,

    h('div', { class: 'cols' },
      h('div', { class: 'panel' }, h('div', { class: 'ph' }, 'Server'),
        kv([
          ['Address', h('span', null, h('code', null, origin), ' ', button('Copy', { small: true, onclick: () => copy(origin, 'Address copied') }))],
          ['Status', status('Running', true)],
          ['Version', h('span', { class: 'num' }, `${s.version} (API ${s.apiVersion})`)],
          ['Up for', h('span', { class: 'num' }, duration(s.uptimeSeconds))],
          ['Memory', h('span', { class: 'num' }, `${s.memoryMb} MB`)],
          ['Runtime', h('span', { class: 'num' }, `Node ${s.node}, ${s.platform}`)],
          ['Data folder', h('code', null, s.dataDir)],
        ])),
      h('div', { class: 'panel' }, h('div', { class: 'ph' }, 'Services'),
        h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null,
          h('tr', null, h('td', null, 'Voice and video'), h('td', null, s.calls.configured ? (s.calls.reachable ? status('Ready', true) : status('Not reachable', 'bad')) : status('Off', false))),
          h('tr', null, h('td', null, 'Push notifications'), h('td', null, status(s.push.configured ? 'On' : 'Off', s.push.configured))),
          h('tr', null, h('td', null, 'Backups kept here'), h('td', null, status(info.features.backups ? `On, ${Math.round(info.limits.backupQuotaMb / 1024 * 10) / 10} GB each` : 'Off', info.features.backups))),
          h('tr', null, h('td', null, 'Browser proxy'), h('td', null, status(info.features.browser ? 'On' : 'Off', info.features.browser))),
          h('tr', null, h('td', null, 'Registration'), h('td', null, info.registration === 'open' ? 'Open' : info.houseKey ? 'Invite or house key' : 'Invite only')))))),
    ),

    h('div', { class: 'cols' },
      h('div', { class: 'panel' }, h('div', { class: 'ph' }, 'Counts'),
        kv([
          ['People', h('span', { class: 'num' }, String(s.counts.users))],
          ['Signed in now', h('span', { class: 'num' }, String(s.counts.signedIn))],
          ['Chats and rooms', h('span', { class: 'num' }, String(s.counts.rooms))],
          ['Messages', h('span', { class: 'num' }, String(s.counts.messages))],
          ['Files shared', h('span', { class: 'num' }, String(s.counts.attachments))],
          ['Unused invites', h('span', { class: 'num' }, String(s.counts.openInvites))],
        ])),
      h('div', { class: 'panel' }, h('div', { class: 'ph' }, 'Storage', h('span', { class: 'meta num' }, bytes(total))),
        h('div', { class: 'pad' }, h('div', { class: 'bar', role: 'img', 'aria-label': parts.map(([n, v]) => `${n} ${bytes(v)}`).join(', ') }, parts.filter(([, v]) => v > 0).map(([, v, c]) => h('span', { style: `--c:${c};flex:${v} 1 0` })))),
        h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, parts.map(([n, v, c]) => h('tr', null, h('td', null, h('span', { class: 'swatch', style: `--c:${c}` }), n), h('td', { class: 'r num' }, bytes(v))))))))),

    showList ? h('div', { class: 'panel' },
      h('div', { class: 'ph' }, 'Setup', h('span', { class: 'meta' }, `${doneCount} of ${steps.length} done `, h('button', { type: 'button', class: 'link', onclick: () => { try { localStorage.setItem(DISMISSED, '1'); } catch { /* ignore */ } ctx.render(); } }, 'Hide'))),
      h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, steps.map((x) => h('tr', { class: x.done ? 'off' : '' }, h('td', null, x.done ? '✓ ' : '☐ ', x.t), h('td', { class: 'actions' }, !x.done && x.go ? button(x.go[0], { small: true, onclick: x.go[1] }) : null))))))) : null,

    s.supervised ? h('div', null, button('Restart server', { kind: 'danger', onclick: async () => {
      if (!(await confirmBox({ title: 'Restart the server', text: 'People are disconnected for a few seconds and reconnect by themselves.', yes: 'Restart', danger: true }))) return;
      try { await api('/api/admin/restart', { method: 'POST' }); toast('Restarting. This page reconnects by itself.'); setTimeout(() => ctx.render(), 6000); } catch (e) { toast(e.message, true); }
    } })) : null);
}
