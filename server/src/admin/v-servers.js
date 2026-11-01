import { ago, api, button, confirmBox, h, modal, pageHead, pill, secretDialog, toast } from './ui.js';

/** The dialog that links this server to a main server. `fresh` is the first-run screen where nobody is signed in yet. */
export async function joinDialog(afterJoin) {
  const code = h('textarea', { class: 'input mono', rows: '3', 'aria-label': 'Mirror code', placeholder: 'hm1.…', spellcheck: 'false' });
  const name = h('input', { class: 'input', 'aria-label': 'Name of this server', value: location.hostname, maxlength: '60' });
  const url = h('input', { class: 'input mono', 'aria-label': 'Address of this server', value: location.origin });
  const err = h('div', { class: 'error-text', role: 'alert', hidden: true });
  const ok = await modal({
    title: 'Make this a mirror',
    body: [
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'Mirror code'), code),
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'Name of this server'), name),
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'Address people reach this server at'), url),
      err,
    ],
    buttons: [{ label: 'Cancel', value: false }, { label: 'Make mirror', value: true, kind: 'primary' }],
  });
  if (!ok) return false;
  try {
    await api('/api/admin/cluster/join', { method: 'POST', body: { code: code.value.trim(), name: name.value.trim(), origin: url.value.trim() } });
    toast('Linked. Copying everything from the main server.');
    await afterJoin?.();
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}

const roleOf = (n) => (n.main ? (n.writable ? 'Main' : 'Main, starting') : n.writable ? 'Standing in' : 'Mirror');

export async function servers(ctx) {
  const c = await api('/api/admin/cluster');
  ctx.state.cluster = c;
  const refresh = () => ctx.render();

  const addMirror = async () => {
    const name = h('input', { class: 'input', 'aria-label': 'Name for the mirror', placeholder: `Mirror ${c.nodes.length || 1}`, maxlength: '60' });
    const url = h('input', { class: 'input mono', 'aria-label': 'Address of this server', value: c.selfUrl || location.origin });
    const ok = await modal({
      title: 'Add a mirror',
      body: [
        h('div', { class: 'field' }, h('label', { class: 'label' }, 'Name for the mirror'), name),
        h('div', { class: 'field' }, h('label', { class: 'label' }, 'Address the mirror reaches this server at'), url),
      ],
      buttons: [{ label: 'Cancel', value: false }, { label: 'Make code', value: true, kind: 'primary' }],
    });
    if (!ok) return;
    try {
      const r = await api('/api/admin/cluster/add-mirror', { method: 'POST', body: { origin: url.value.trim(), name: name.value.trim() } });
      await secretDialog({ title: 'Mirror code', lead: 'Paste it on the other server. It works once. Keep it private.', value: r.code });
      refresh();
    } catch (e) { toast(e.message, true); }
  };

  const makeMain = async () => {
    if (!(await confirmBox({ title: 'Make this the main server', text: 'Use this when the main server is gone for good. This server becomes the main one, the other mirrors follow it, and the old main server, if it ever returns, becomes a mirror of this one.', yes: 'Make main', danger: true }))) return;
    try { await api('/api/admin/cluster/main', { method: 'POST' }); toast('This is now the main server'); refresh(); } catch (e) { toast(e.message, true); }
  };

  const leave = async () => {
    if (!(await confirmBox({ title: 'Stop being a mirror', text: 'This server keeps what it has copied and runs on its own. It no longer follows the main server.', yes: 'Stop', danger: true }))) return;
    try { await api('/api/admin/cluster/leave', { method: 'POST' }); toast('Left the group'); refresh(); } catch (e) { toast(e.message, true); }
  };

  const remove = async (n) => {
    if (!(await confirmBox({ title: `Remove ${n.name}`, text: 'It stops following this server and keeps what it has copied.', yes: 'Remove', danger: true }))) return;
    try { await api(`/api/admin/cluster/nodes/${n.id}`, { method: 'DELETE' }); toast('Removed'); refresh(); } catch (e) { toast(e.message, true); }
  };

  const rename = async () => {
    const name = h('input', { class: 'input', 'aria-label': 'Name', value: c.name, maxlength: '60' });
    const url = h('input', { class: 'input mono', 'aria-label': 'Address', value: c.selfUrl || location.origin });
    const ok = await modal({
      title: 'This server',
      body: [h('div', { class: 'field' }, h('label', { class: 'label' }, 'Name'), name), h('div', { class: 'field' }, h('label', { class: 'label' }, 'Address people reach it at'), url)],
      buttons: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, kind: 'primary' }],
    });
    if (!ok) return;
    try { await api('/api/admin/cluster/self', { method: 'PUT', body: { name: name.value.trim(), url: url.value.trim() } }); refresh(); } catch (e) { toast(e.message, true); }
  };

  if (!c.clustered) {
    return h('div', null,
      pageHead({ title: 'Mirrors' }),
      h('div', { class: 'panel' },
        h('div', { class: 'ph' }, 'Keep a copy on another server'),
        h('div', { class: 'pad', style: 'display:grid;gap:12px' },
          h('div', { class: 'row-actions' },
            button('Add a mirror', { kind: 'primary', onclick: addMirror }),
            button('Make this a mirror of another server', { onclick: () => joinDialog(refresh) })))));
  }

  const isMirror = c.role === 'mirror';
  const rows = c.nodes.map((n) => h('tr', null,
    h('td', null, h('div', null, n.name, n.self ? h('span', { class: 'muted' }, ' (this server)') : null)),
    h('td', null, h('span', { class: 'mono' }, n.url || 'no address')),
    h('td', null, pill(roleOf(n), n.writable ? 'good' : '')),
    h('td', null, n.self || n.reachable ? pill('Online', 'good') : pill('Not answering', 'warn'), n.self ? null : h('span', { class: 'muted' }, n.seenAt ? ` ${ago(n.seenAt)}` : '')),
    h('td', { class: 'actions' }, n.self ? button('Edit', { small: true, onclick: rename }) : isMirror ? null : button('Remove', { small: true, kind: 'danger', onclick: () => remove(n) }))));
  c.pending.forEach((p) => rows.push(h('tr', null,
    h('td', null, p.name), h('td', { class: 'muted' }, 'Waiting for the code to be used'), h('td', null, pill('Mirror')), h('td', null, pill('Not linked yet', 'warn')),
    h('td', { class: 'actions' }, button('Cancel', { small: true, onclick: () => api(`/api/admin/cluster/nodes/${p.id}`, { method: 'DELETE' }).then(refresh, (e) => toast(e.message, true)) })))));

  const sync = c.lastSync;
  const status = isMirror
    ? (c.writable ? 'Standing in for the main server' : sync?.ok ? `Copied ${ago(sync.at)}` : sync && !sync.ok ? 'Last copy failed' : 'Starting')
    : c.recovering ? 'Checking for a stand-in before serving' : 'Serving';

  return h('div', null,
    pageHead({ title: 'Mirrors', actions: [
      isMirror ? button('Make this the main server', { kind: 'danger', onclick: makeMain }) : null,
      isMirror ? button('Stop being a mirror', { onclick: leave }) : button('Add a mirror', { kind: 'primary', onclick: addMirror }),
    ] }),
    c.error ? h('div', { class: 'banner bad', role: 'alert' }, h('div', { class: 'grow' }, c.error)) : null,
    h('div', { class: 'panel' },
      h('div', { class: 'ph' }, 'Servers in this group', h('span', { class: 'meta num' }, `Round ${c.epoch}`)),
      h('div', { class: 'pad' }, h('span', { class: 'muted' }, 'This server: '), status),
      h('div', { class: 'table-wrap' }, h('table', { class: 'fixed' },
        h('colgroup', null, ['22%', '34%', '16%', '18%', '10%'].map((w) => h('col', { style: `width:${w}` }))),
        h('thead', null, h('tr', null, ['Server', 'Address', 'Role', 'State', ''].map((t) => h('th', null, t)))),
        h('tbody', null, rows)))));
}
