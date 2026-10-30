import { ago, api, bytes, button, confirmBox, drawer, h, pageHead, pill, secretDialog, toast } from './ui.js';

const joined = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export async function people(ctx) {
  const { users } = await api('/api/admin/users');
  ctx.setCounts({ users: users.length });
  const me = ctx.state.me.user;
  const admins = users.filter((u) => u.isAdmin && !u.disabled).length;
  let query = '';
  let filter = 'all';
  const listHost = h('div', { class: 'table-wrap' });

  const matches = (u) => {
    if (filter === 'admins' && !u.isAdmin) return false;
    if (filter === 'off' && !u.disabled) return false;
    const q = query.trim().toLowerCase();
    return !q || u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q);
  };

  function manage(u) {
    const self = u.id === me.id;
    const lastAdmin = u.isAdmin && admins <= 1;
    const done = async (fn, text, close) => { try { await fn(); toast(text); close(); ctx.render(); } catch (e) { toast(e.message, true); } };
    const patch = (body) => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body });
    drawer((close) => [
      h('h2', null, u.displayName === u.username ? u.username : `${u.displayName} (${u.username})`),
      h('div', { class: 'body manage' },
        row('Role', u.isAdmin ? 'Administrator' : 'Member', u.isAdmin
          ? button('Remove admin', { small: true, disabled: lastAdmin, onclick: () => done(() => patch({ isAdmin: false }), 'Done', close) })
          : button('Make admin', { small: true, disabled: u.disabled, onclick: () => done(() => patch({ isAdmin: true }), 'Done', close) }), lastAdmin ? 'The only administrator.' : u.disabled && !u.isAdmin ? 'Switch the account on first.' : null),
        row('Account', u.disabled ? 'Switched off' : 'On', u.disabled
          ? button('Switch on', { small: true, onclick: () => done(() => patch({ disabled: false }), 'Switched on', close) })
          : button('Switch off', { small: true, disabled: self || lastAdmin, onclick: async () => {
            if (await confirmBox({ title: `Switch off ${u.username}`, text: 'They are signed out everywhere and cannot sign in until you switch the account on again.', yes: 'Switch off', danger: true })) done(() => patch({ disabled: true }), 'Switched off', close);
          } }), self ? 'Not your own account.' : lastAdmin ? 'The only administrator.' : null),
        row('Password', 'Signs them out', button('Reset', { small: true, onclick: async () => {
          if (!(await confirmBox({ title: `Reset the password of ${u.username}`, text: 'They are signed out everywhere. You get a temporary password, shown once.', yes: 'Reset', danger: true }))) return;
          try { const r = await api(`/api/admin/users/${u.id}/reset-password`, { method: 'POST' }); close(); await secretDialog({ title: 'Temporary password', lead: `For ${u.username}. Shown once.`, value: r.password }); ctx.render(); } catch (e) { toast(e.message, true); }
        } })),
        row('Joined', joined(u.createdAt)), row('Last signed in', ago(u.lastSignIn)), row('Messages', String(u.messages)), row('Backups here', u.backupBytes ? bytes(u.backupBytes) : 'None'),
        row('Remove', 'Deletes the account, messages and backups', button('Remove', { small: true, kind: 'danger', disabled: self || lastAdmin, onclick: async () => {
          if (await confirmBox({ title: `Remove ${u.username}`, text: 'The account, its messages, its chat memberships and its backups are deleted for good. Switch the account off instead to only stop them signing in.', yes: 'Remove', danger: true })) done(() => api(`/api/admin/users/${u.id}`, { method: 'DELETE' }), 'Removed', close);
        } }), self ? 'Not your own account.' : lastAdmin ? 'The only administrator.' : null)),
      h('div', { class: 'actions' }, button('Close', { onclick: close })),
    ]);
  }

  const row = (k, v, action, note) => h('div', { class: 'row' }, h('div', null, h('div', null, h('span', { class: 'muted' }, k + ': '), v), note ? h('div', { class: 'd' }, note) : null), action || null);

  function paint() {
    const shown = users.filter(matches);
    if (!shown.length) { listHost.replaceChildren(h('div', { class: 'empty' }, users.length ? 'No one matches' : 'No people')); return; }
    listHost.replaceChildren(h('table', null,
      h('thead', null, h('tr', null, ['Username', 'Name', 'Role', 'Joined', 'Last signed in', 'Messages', 'Backups', ''].map((t, i) => h('th', { class: i > 4 ? 'r' : '' }, t)))),
      h('tbody', null, shown.map((u) => h('tr', { class: u.disabled ? 'off' : '' },
        h('td', null, u.username, u.id === me.id ? ' ' : '', u.id === me.id ? pill('you') : null),
        h('td', null, u.displayName),
        h('td', null, u.isAdmin ? 'Administrator' : 'Member', u.disabled ? [' ', pill('off', 'bad')] : null, u.twoStep ? [' ', pill('2FA', 'good')] : null),
        h('td', { class: 'num' }, joined(u.createdAt)),
        h('td', null, ago(u.lastSignIn)),
        h('td', { class: 'r num' }, String(u.messages)),
        h('td', { class: 'r num' }, u.backupBytes ? bytes(u.backupBytes) : '-'),
        h('td', { class: 'actions' }, button('Manage', { small: true, onclick: () => manage(u) })))))));
  }

  const filters = h('select', { class: 'input', style: 'width:auto', 'aria-label': 'Filter', onchange: (e) => { filter = e.target.value; paint(); } },
    h('option', { value: 'all' }, `All (${users.length})`), h('option', { value: 'admins' }, `Administrators (${users.filter((u) => u.isAdmin).length})`), h('option', { value: 'off' }, `Switched off (${users.filter((u) => u.disabled).length})`));
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search', 'aria-label': 'Search people', oninput: (e) => { query = e.target.value; paint(); } });
  paint();

  return h('div', null,
    pageHead({ title: 'People', actions: button('Invite someone', { kind: 'primary', onclick: () => ctx.go('invites') }) }),
    h('div', { class: 'panel' }, h('div', { class: 'toolbar' }, h('div', { class: 'search grow' }, search), filters), listHost));
}
