import { icon } from './icons.js';
import { ring, sparkline } from './charts.js';
import { api, bytes, button, confirmBox, copy, duration, h, pageHead, toast } from './ui.js';

const DISMISSED = 'hearth-admin-checklist-dismissed';
const dismissed = () => { try { return localStorage.getItem(DISMISSED) === '1'; } catch { return false; } };

// A short history of the server's memory and how many people are signed in, kept while this page is open.
const history = { memory: [], signedIn: [] };
const remember = (s) => {
  history.memory.push(s.memoryMb); history.signedIn.push(s.counts.signedIn);
  for (const k of Object.keys(history)) if (history[k].length > 90) history[k].shift();
};

const tile = (ico, label, value, sub) => h('div', { class: 'tile' }, h('div', { class: 'tile-ico' }, icon(ico)), h('div', { class: 'tile-body' }, h('div', { class: 'tile-n num' }, String(value)), h('div', { class: 'tile-l' }, label), sub ? h('div', { class: 'tile-s' }, sub) : null));

const badge = (text, kind) => h('span', { class: 'badge ' + kind }, text);

function service({ ico, title, state, kind, line }) {
  return h('div', { class: 'svc' }, h('div', { class: 'svc-ico' }, icon(ico)), h('div', { class: 'svc-body' }, h('div', { class: 'svc-t' }, title), h('div', { class: 'svc-l' }, line)), badge(state, kind));
}

const kv = (rows) => h('div', { class: 'kv' }, rows.flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', null, v)]));

export async function overview(ctx) {
  const [s, info] = await Promise.all([api('/api/admin/status'), api('/api/server/info')]);
  ctx.state.info = info;
  ctx.setCounts({ users: s.counts.users, invites: s.counts.openInvites });
  remember(s);
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
  const parts = [['Shared files', s.storageBytes.uploads, 'var(--c1)'], ['Backups', s.storageBytes.backups, 'var(--c2)'], ['Database', s.storageBytes.database, 'var(--c3)']];
  const callsState = s.calls.configured ? (s.calls.reachable ? ['Ready', 'good'] : ['Unreachable', 'bad']) : ['Off', 'off'];

  return h('div', null,
    pageHead({ title: info.name, actions: s.supervised ? button('Restart server', { kind: 'danger', onclick: async () => {
      if (!(await confirmBox({ title: 'Restart the server', text: 'People are disconnected for a few seconds and reconnect by themselves.', yes: 'Restart', danger: true }))) return;
      try { await api('/api/admin/restart', { method: 'POST' }); toast('Restarting. This page reconnects by itself.'); setTimeout(() => ctx.render(), 6000); } catch (e) { toast(e.message, true); }
    } }) : null }),
    banners.length ? h('div', { class: 'banners' }, banners.map((b) => h('div', { class: 'banner', role: 'note' }, h('div', { class: 'grow' }, b.text), b.action ? button(b.action[0], { small: true, onclick: b.action[1] }) : null))) : null,

    h('div', { class: 'tiles' },
      tile('people', 'People', s.counts.users, `${s.counts.signedIn} signed in now`),
      tile('msg', 'Messages', s.counts.messages, `${s.counts.rooms} chats and rooms`),
      tile('database', 'Storage used', bytes(total), `${s.counts.attachments} files shared`),
      tile('invites', 'Unused invites', s.counts.openInvites)),

    h('div', { class: 'cols' },
      h('div', { class: 'panel' }, h('div', { class: 'ph' }, 'Activity', h('span', { class: 'meta' }, 'since this page opened')),
        h('div', { class: 'charts' },
          h('div', { class: 'chart' }, h('div', { class: 'chart-h' }, h('span', null, 'Signed in'), h('strong', { class: 'num' }, String(s.counts.signedIn))), sparkline(history.signedIn)),
          h('div', { class: 'chart' }, h('div', { class: 'chart-h' }, h('span', null, 'Server memory'), h('strong', { class: 'num' }, `${s.memoryMb} MB`)), sparkline(history.memory)))),
      h('div', { class: 'panel' }, h('div', { class: 'ph' }, 'Storage', h('span', { class: 'meta num' }, bytes(total))),
        h('div', { class: 'storage' },
          h('div', { class: 'ring-wrap' }, ring(parts.map(([, v, c]) => ({ value: v, color: c }))), h('div', { class: 'ring-c num' }, bytes(total))),
          h('div', { class: 'legend' }, parts.map(([n, v, c]) => h('div', { class: 'lg' }, h('span', { class: 'swatch', style: `--c:${c}` }), h('span', { class: 'lg-n' }, n), h('span', { class: 'num' }, bytes(v)))))))),

    h('div', { class: 'panel' }, h('div', { class: 'ph' }, 'Services'),
      h('div', { class: 'svcs' },
        service({ ico: 'calls', title: 'Voice and video', state: callsState[0], kind: callsState[1], line: s.calls.configured ? 'LiveKit' : 'Not set up' }),
        service({ ico: 'push', title: 'Push notifications', state: s.push.configured ? 'On' : 'Off', kind: s.push.configured ? 'good' : 'off', line: 'Browsers and PWAs' }),
        service({ ico: 'backups', title: 'Backups kept here', state: info.features.backups ? 'On' : 'Off', kind: info.features.backups ? 'good' : 'off', line: `${Math.round(info.limits.backupQuotaMb / 1024 * 10) / 10} GB for each person` }),
        service({ ico: 'browser', title: 'Browser proxy', state: info.features.browser ? 'On' : 'Off', kind: info.features.browser ? 'good' : 'off', line: 'For signed-in people' }),
        service({ ico: 'user', title: 'Registration', state: info.registration === 'open' ? 'Open' : 'Invite', kind: info.registration === 'open' ? 'warn' : 'good', line: info.houseKey ? 'A house key is set' : 'Invite codes' }))),

    h('div', { class: 'cols' },
      h('div', { class: 'panel' }, h('div', { class: 'ph' }, 'Server'),
        kv([
          ['Address', h('span', null, h('code', null, origin), ' ', button('Copy', { small: true, onclick: () => copy(origin, 'Address copied') }))],
          ['Version', h('span', { class: 'num' }, `${s.version} (API ${s.apiVersion})`)],
          ['Up for', h('span', { class: 'num' }, duration(s.uptimeSeconds))],
          ['Runtime', h('span', { class: 'num' }, `Node ${s.node}, ${s.platform}`)],
          ['Data folder', h('code', null, s.dataDir)],
        ])),
      showList ? h('div', { class: 'panel' },
        h('div', { class: 'ph' }, 'Setup', h('span', { class: 'meta' }, `${doneCount} of ${steps.length} done `, h('button', { type: 'button', class: 'link', onclick: () => { try { localStorage.setItem(DISMISSED, '1'); } catch { /* ignore */ } ctx.render(); } }, 'Hide'))),
        h('div', { class: 'meter' }, h('span', { style: `width:${(doneCount / steps.length) * 100}%` })),
        h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, steps.map((x) => h('tr', { class: x.done ? 'off' : '' }, h('td', null, x.done ? '✓ ' : '☐ ', x.t), h('td', { class: 'actions' }, !x.done && x.go ? button(x.go[0], { small: true, onclick: x.go[1] }) : null))))))) : h('div', { class: 'panel' }, h('div', { class: 'ph' }, 'Counts'),
        kv([['People', String(s.counts.users)], ['Signed in now', String(s.counts.signedIn)], ['Chats and rooms', String(s.counts.rooms)], ['Messages', String(s.counts.messages)], ['Files shared', String(s.counts.attachments)]]))));
}
