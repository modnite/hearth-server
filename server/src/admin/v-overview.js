import { icon } from './icons.js';
import { api, bytes, button, copy, confirmBox, duration, h, pageHead, toast } from './ui.js';

const DISMISSED = 'hearth-admin-checklist-dismissed';
const dismissed = () => { try { return localStorage.getItem(DISMISSED) === '1'; } catch { return false; } };

function stat(n, label) {
  return h('div', { class: 'stat' }, h('div', { class: 'n' }, String(n)), h('div', { class: 'l' }, label));
}

function service({ ico, title, text, on, label }) {
  return h('div', { class: 'svc' }, h('span', { class: 'ico' }, icon(ico)), h('div', null, h('div', { class: 't' }, title), h('div', { class: 'd' }, text)),
    h('span', { class: 'pill ' + (on === true ? 'good' : on === 'bad' ? 'bad' : '') }, h('span', { class: 'dot' }), label));
}

export async function overview(ctx) {
  const [s, info] = await Promise.all([api('/api/admin/status'), api('/api/server/info')]);
  ctx.state.info = info;
  ctx.setCounts({ users: s.counts.users, invites: s.counts.openInvites });
  const origin = location.origin;

  // things worth knowing, at the top
  const banners = [];
  if (!s.secrets.sessionSecretChanged) banners.push({ text: 'SESSION_SECRET is still the built-in default. Set a long random value in the server environment so sessions cannot be forged.' });
  if (s.calls.configured && !s.calls.reachable) banners.push({ text: 'LiveKit is set up, but this server cannot reach it. Calls will fail until it can.', action: ['Calls settings', () => ctx.go('settings', 'Calls')] });
  if (info.registration === 'open') banners.push({ text: 'Anyone who can reach this server can create an account.', action: ['Change this', () => ctx.go('settings', 'Joining')] });

  const steps = [
    { done: true, t: 'Create the administrator', d: 'You did this at setup.' },
    { done: info.name !== 'Hearth', t: 'Name your server', d: 'People see the name on the sign-in screen of every client.', go: ['Open settings', () => ctx.go('settings', 'Server')] },
    { done: s.counts.users > 1, t: 'Invite your first person', d: 'Make an invite code, or set a house key people can use.', go: ['Invite', () => ctx.go('invites')] },
    { done: s.calls.configured, t: 'Set up voice and video', d: 'Needs a LiveKit server. Optional.', go: ['Calls settings', () => ctx.go('settings', 'Calls')] },
    { done: s.push.configured, t: 'Turn on notifications', d: 'Browser and PWA push needs a pair of keys. Optional.', go: ['Notification settings', () => ctx.go('settings', 'Notifications')] },
  ];
  const doneCount = steps.filter((x) => x.done).length;
  const showList = !dismissed() && doneCount < steps.length;

  const total = s.storageBytes.uploads + s.storageBytes.backups + s.storageBytes.database;
  const parts = [
    ['Shared files', s.storageBytes.uploads, 'var(--accent)'],
    ['Backups', s.storageBytes.backups, 'light-dark(#2f6fcb, #6aa8f0)'],
    ['Database', s.storageBytes.database, 'light-dark(#3e9a5a, #66c98a)'],
  ];

  return h('div', { class: 'page fade' },
    pageHead({ eyebrow: 'Overview', title: info.name, lead: 'How your server is doing right now.' }),
    banners.length ? h('div', { class: 'banners' }, banners.map((b) => h('div', { class: 'banner warn', role: 'note' }, icon('alert'), h('div', { class: 'grow' }, b.text), b.action ? button(b.action[0], { small: true, onclick: b.action[1] }) : null))) : null,

    h('section', { class: 'hero' },
      h('div', null,
        h('div', { class: 'status' }, h('span', { class: 'dot good' }), 'Running'),
        h('h2', null, 'Connect a client'),
        h('p', null, 'Give people this address. They enter it in Ember or any other Hearth client, then sign in or use an invite code.'),
        h('div', { class: 'address' }, h('code', null, origin), h('button', { type: 'button', class: 'btn', onclick: () => copy(origin, 'Address copied') }, icon('copy', 'sm'), 'Copy'))),
      h('div', { class: 'facts' },
        h('div', { class: 'fact' }, h('div', { class: 'k' }, 'Version'), h('div', { class: 'v num' }, s.version)),
        h('div', { class: 'fact' }, h('div', { class: 'k' }, 'Up for'), h('div', { class: 'v num' }, duration(s.uptimeSeconds))),
        h('div', { class: 'fact' }, h('div', { class: 'k' }, 'Memory'), h('div', { class: 'v num' }, `${s.memoryMb} MB`)))),

    showList ? h('section', null,
      h('div', { class: 'section-title' }, h('h2', null, 'Get started'), h('span', { class: 'meta num' }, `${doneCount} of ${steps.length} done`, ' ', h('button', { type: 'button', class: 'link', onclick: () => { try { localStorage.setItem(DISMISSED, '1'); } catch { /* ignore */ } ctx.render(); } }, 'Hide'))),
      h('div', { class: 'panel' },
        h('div', { class: 'progress' }, h('span', { style: `width:${(doneCount / steps.length) * 100}%` })),
        h('div', { class: 'divided' }, steps.map((x) => h('div', { class: 'step' + (x.done ? ' done' : '') }, h('span', { class: 'tick' }, icon('check', 'sm')), h('div', null, h('div', { class: 't' }, x.t), h('div', { class: 'd' }, x.d)), !x.done && x.go ? button(x.go[0], { small: true, onclick: x.go[1] }) : null))))) : null,

    h('section', { class: 'stats' }, stat(s.counts.users, s.counts.users === 1 ? 'person' : 'people'), stat(s.counts.signedIn, 'signed in now'), stat(s.counts.rooms, s.counts.rooms === 1 ? 'chat or room' : 'chats and rooms'), stat(s.counts.messages, s.counts.messages === 1 ? 'message' : 'messages')),

    h('div', { class: 'cols' },
      h('section', null,
        h('div', { class: 'section-title' }, h('h2', null, 'Storage'), h('span', { class: 'meta num' }, bytes(total), ' in use')),
        h('div', { class: 'panel pad' },
          h('div', { class: 'usage-bar', role: 'img', 'aria-label': parts.map(([n, v]) => `${n} ${bytes(v)}`).join(', ') },
            total === 0 ? h('span', { class: 'empty' }) : parts.filter(([, v]) => v > 0).map(([, v, c]) => h('span', { style: `--c:${c};flex:${v} 1 0` }))),
          h('div', { class: 'legend' }, parts.map(([n, v, c]) => h('div', { class: 'item', style: `--c:${c}` }, h('span', { class: 'sw' }), h('span', null, n), h('span', { class: 'val' }, bytes(v))))),
          h('p', { class: 'hint', style: 'margin-top:16px' }, 'All of it is in ', h('code', null, s.dataDir), '. Back that folder up and you have backed up the server.'))),
      h('section', null,
        h('div', { class: 'section-title' }, h('h2', null, 'Services')),
        h('div', { class: 'panel divided' },
          service({ ico: 'phonecall', title: 'Voice and video', text: s.calls.configured ? (s.calls.reachable ? 'LiveKit answers.' : 'Set up, but not reachable.') : 'Not set up.', on: s.calls.configured ? (s.calls.reachable ? true : 'bad') : false, label: s.calls.configured ? (s.calls.reachable ? 'Ready' : 'Unreachable') : 'Off' }),
          service({ ico: 'bell', title: 'Push notifications', text: s.push.configured ? 'Browsers and PWAs can be notified.' : 'Needs web push keys.', on: s.push.configured, label: s.push.configured ? 'On' : 'Off' }),
          service({ ico: 'backups', title: 'Backups for people', text: info.features.backups ? `${Math.round(info.limits.backupQuotaMb / 1024 * 10) / 10} GB each, sealed on their device.` : 'Switched off.', on: info.features.backups, label: info.features.backups ? 'On' : 'Off' }),
          service({ ico: 'globe', title: 'Built-in browser', text: info.features.browser ? 'This server fetches pages for signed-in people.' : 'Switched off.', on: info.features.browser, label: info.features.browser ? 'On' : 'Off' })))),

    h('footer', { class: 'foot' },
      h('p', { class: 'hint num' }, `Node ${s.node} on ${s.platform}. API version ${s.apiVersion}.`,
        s.supervised ? null : ' This server is not run by something that restarts it, so after changing a setting marked "Needs restart" you restart it yourself.'),
      s.supervised ? button('Restart server', { kind: 'danger sm', icon: 'power', onclick: async () => {
        if (!(await confirmBox({ title: 'Restart the server?', text: 'People are disconnected for a few seconds and reconnect by themselves.', yes: 'Restart', danger: true }))) return;
        try { await api('/api/admin/restart', { method: 'POST' }); toast('Restarting. This page reconnects by itself.'); setTimeout(() => ctx.render(), 6000); } catch (e) { toast(e.message, true); }
      } }) : null));
}
