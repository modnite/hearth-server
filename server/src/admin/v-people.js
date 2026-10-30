import { icon } from './icons.js';
import { ago, api, avatar, bytes, button, confirmBox, drawer, emptyState, h, pageHead, pill, secretDialog, toast } from './ui.js';

const joined = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export async function people(ctx) {
  const { users } = await api('/api/admin/users');
  ctx.setCounts({ users: users.length });
  const me = ctx.state.me.user;
  const admins = users.filter((u) => u.isAdmin && !u.disabled).length;
  let query = '';
  let filter = 'all';
  const listHost = h('div');

  const matches = (u) => {
    if (filter === 'admins' && !u.isAdmin) return false;
    if (filter === 'off' && !u.disabled) return false;
    const q = query.trim().toLowerCase();
    return !q || u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q);
  };

  function openPerson(u) {
    const self = u.id === me.id;
    const lastAdmin = u.isAdmin && admins <= 1;
    const done = async (fn, text, close) => { try { await fn(); toast(text); close(); ctx.render(); } catch (e) { toast(e.message, true); } };
    drawer((close) => [
      h('div', { class: 'drawer-head' },
        avatar(u, 'lg'),
        h('div', { class: 'grow' }, h('h2', null, u.displayName), h('div', { class: 'sub' }, u.username),
          h('div', { class: 'pills' }, self ? pill('You', 'accent') : null, u.isAdmin ? pill('Administrator', 'accent') : null, u.disabled ? pill('Switched off', 'bad') : null, u.twoStep ? pill('Two-step on', 'good') : null)),
        button('', { icon: 'x', kind: 'quiet', title: 'Close', onclick: close })),
      h('div', { class: 'drawer-body' },
        h('div', { class: 'kv' },
          h('div', null, h('div', { class: 'k' }, 'Joined'), h('div', { class: 'v' }, joined(u.createdAt))),
          h('div', null, h('div', { class: 'k' }, 'Last signed in'), h('div', { class: 'v' }, ago(u.lastSignIn))),
          h('div', null, h('div', { class: 'k' }, 'Messages'), h('div', { class: 'v num' }, String(u.messages))),
          h('div', null, h('div', { class: 'k' }, 'Backups kept here'), h('div', { class: 'v num' }, u.backupBytes ? bytes(u.backupBytes) : 'None'))),
        h('div', { class: 'acts' }, h('h3', null, 'Role'), h('div', { class: 'stack' },
          u.isAdmin
            ? action({ ic: 'user', t: 'Remove administrator', d: lastAdmin ? 'This is the only administrator.' : 'They keep their account but lose the admin panel.', disabled: lastAdmin, onclick: () => done(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { isAdmin: false } }), 'No longer an administrator', close) })
            : action({ ic: 'shield', t: 'Make administrator', d: u.disabled ? 'Switch the account on first.' : 'They can manage this server from the panel.', disabled: u.disabled, onclick: () => done(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { isAdmin: true } }), 'Now an administrator', close) }))),
        h('div', { class: 'acts' }, h('h3', null, 'Access'), h('div', { class: 'stack' },
          u.disabled
            ? action({ ic: 'power', t: 'Switch the account on', d: 'They can sign in again.', onclick: () => done(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { disabled: false } }), 'Switched on', close) })
            : action({ ic: 'shieldoff', t: 'Switch the account off', d: self ? 'You cannot switch off your own account.' : lastAdmin ? 'This is the only administrator.' : 'Signs them out everywhere. Their chats stay.', disabled: self || lastAdmin, onclick: async () => {
              if (await confirmBox({ title: `Switch off ${u.displayName}?`, text: 'They are signed out everywhere and cannot sign in until you switch the account on again. Their chats stay.', yes: 'Switch off', danger: true })) done(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { disabled: true } }), 'Switched off', close);
            } }),
          action({ ic: 'key', t: 'Reset password', d: 'Signs them out and gives you a temporary password to pass on.', onclick: async () => {
            if (!(await confirmBox({ title: `Reset ${u.displayName}'s password?`, text: 'They are signed out everywhere. You get a temporary password, shown once.', yes: 'Reset password', danger: true }))) return;
            try { const r = await api(`/api/admin/users/${u.id}/reset-password`, { method: 'POST' }); close(); await secretDialog({ title: 'Temporary password', lead: `Give this to ${u.displayName}. It is shown once, and they should change it after signing in.`, value: r.password }); ctx.render(); } catch (e) { toast(e.message, true); }
          } }))),
        h('div', { class: 'acts' }, h('h3', null, 'Danger zone'), h('div', { class: 'stack' },
          action({ ic: 'trash', t: 'Remove the account', d: self ? 'You cannot remove your own account.' : lastAdmin ? 'This is the only administrator.' : 'Deletes the account, its messages, chat memberships and backups for good.', danger: true, disabled: self || lastAdmin, onclick: async () => {
            if (await confirmBox({ title: `Remove ${u.displayName}?`, text: 'The account, its messages, its chat memberships and its backups are deleted for good. Switch the account off instead if you only want to stop them signing in.', yes: 'Remove for good', danger: true })) done(() => api(`/api/admin/users/${u.id}`, { method: 'DELETE' }), 'Removed', close);
          } })))),
    ]);
  }

  const action = ({ ic, t, d, onclick, disabled, danger }) =>
    h('button', { type: 'button', class: 'act' + (danger ? ' danger' : ''), disabled, onclick }, icon(ic), h('span', null, h('span', { class: 't' }, t), disabled ? h('span', { class: 'd' }, d) : null));

  function paint() {
    const shown = users.filter(matches);
    if (!users.length) { listHost.replaceChildren(emptyState({ title: 'Nobody here yet' })); return; }
    if (!shown.length) { listHost.replaceChildren(emptyState({ title: 'No one matches' })); return; }
    listHost.replaceChildren(
      h('div', { class: 'list-head', 'aria-hidden': 'true' }, h('span', null, 'Person'), h('span', null, 'Joined'), h('span', null, 'Last signed in'), h('span', { class: 'r' }, 'Messages'), h('span', { class: 'r' }, 'Backups'), h('span')),
      h('div', { class: 'divided' }, shown.map((u) => h('button', { type: 'button', class: 'row-person' + (u.disabled ? ' off' : ''), onclick: () => openPerson(u), 'aria-label': `${u.displayName}, open details` },
        h('span', { class: 'who' }, avatar(u), h('span', { class: 'names' },
          h('strong', null, h('span', { class: 't' }, u.displayName), u.id === me.id ? pill('You', 'accent') : null, u.isAdmin ? pill('Admin', 'accent') : null, u.disabled ? pill('Off', 'bad') : null),
          u.username.toLowerCase() === u.displayName.toLowerCase() ? null : h('small', null, u.username))),
        h('span', { class: 'cell' }, joined(u.createdAt)),
        h('span', { class: 'cell' }, ago(u.lastSignIn)),
        h('span', { class: 'cell r' }, String(u.messages)),
        h('span', { class: 'cell r' }, u.backupBytes ? bytes(u.backupBytes) : '–'),
        h('span', { class: 'chev' }, icon('chevron', 'sm'))))));
  }

  const chip = (id, label, n) => h('button', { type: 'button', 'aria-pressed': String(filter === id), onclick: () => { filter = id; chips.replaceChildren(...mk()); paint(); } }, label, h('span', { class: 'n' }, String(n)));
  const mk = () => [chip('all', 'All', users.length), chip('admins', 'Admins', users.filter((u) => u.isAdmin).length), chip('off', 'Switched off', users.filter((u) => u.disabled).length)];
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter' }, mk());
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search by name', 'aria-label': 'Search people', oninput: (e) => { query = e.target.value; paint(); } });
  paint();

  return h('div', { class: 'page fade' },
    pageHead({ title: 'People', actions: button('Invite someone', { kind: 'primary', icon: 'plus', onclick: () => ctx.go('invites') }) }),
    h('div', null,
      h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search'), search), chips),
      h('div', { class: 'panel' }, listHost)));
}
