import { ago, api, button, confirmBox, copy, day, drawer, h, pageHead, pill, time, toast } from './ui.js';

const SOURCE = { ember: 'Ember', web: 'Web app' };
const sourceName = (s) => SOURCE[s] || s;
const stamp = (ms) => `${day(ms)} ${time(ms)}`;

/** Plain text of one report, for pasting into a bug report or an assistant. */
function asText(group, r) {
  return [
    `${sourceName(group.source)} ${r.appVersion || ''} ${r.kind}`.trim(),
    [r.platform, r.device].filter(Boolean).join(', '),
    stamp(r.at),
    '',
    r.message,
    '',
    r.stack,
    r.context ? `\nContext: ${JSON.stringify(r.context)}` : '',
  ].join('\n').trim();
}

async function openGroup(g, ctx) {
  const { group, reports } = await api(`/api/admin/crashes/${g.signature}`);
  const note = h('input', { class: 'input', 'aria-label': 'Note', placeholder: 'Note', value: group.note, maxlength: '500' });
  const d = drawer((close) => [
    h('h2', null, group.title || 'Crash'),
    h('div', { class: 'body crashbody' },
      h('div', { class: 'manage' },
        h('div', { class: 'row' }, h('span', null, 'Source'), h('span', null, sourceName(group.source), ' ', pill(group.kind))),
        h('div', { class: 'row' }, h('span', null, 'Seen'), h('span', { class: 'num' }, `${group.count} ${group.count === 1 ? 'time' : 'times'}, ${group.people} ${group.people === 1 ? 'person' : 'people'}`)),
        h('div', { class: 'row' }, h('span', null, 'First and last'), h('span', { class: 'num' }, `${stamp(group.first)} to ${stamp(group.last)}`)),
        h('div', { class: 'row' }, h('span', null, 'Versions'), h('span', null, group.versions.join(', ') || 'unknown')),
        h('div', { class: 'row' }, h('span', null, 'State'), group.resolved ? pill('Fixed', 'good') : pill('Open', 'warn'))),
      note,
      reports.map((r) => h('div', { class: 'panel crash-report' },
        h('div', { class: 'ph' }, stamp(r.at), h('span', { class: 'meta' }, [r.appVersion, r.user].filter(Boolean).join(' · '))),
        h('div', { class: 'pad muted' }, [r.platform, r.device].filter(Boolean).join(', ') || 'No device details'),
        r.stack ? h('div', { class: 'codeblock' }, h('pre', null, r.stack)) : null,
        r.context ? h('div', { class: 'codeblock' }, h('pre', null, JSON.stringify(r.context, null, 2))) : null,
        h('div', { class: 'pad' }, button('Copy this report', { small: true, onclick: () => copy(asText(group, r), 'Report copied') }))))),
    h('div', { class: 'actions' },
      button('Delete', { kind: 'danger', onclick: async () => {
        if (!(await confirmBox({ title: 'Delete this crash', text: 'All its reports are removed.', yes: 'Delete', danger: true }))) return;
        try { await api(`/api/admin/crashes/${group.signature}`, { method: 'DELETE' }); close(); toast('Deleted'); ctx.render(); } catch (e) { toast(e.message, true); }
      } }),
      button(group.resolved ? 'Reopen' : 'Mark fixed', { onclick: async () => {
        try { await api(`/api/admin/crashes/${group.signature}/resolve`, { method: 'POST', body: { resolved: !group.resolved, note: note.value } }); close(); ctx.render(); } catch (e) { toast(e.message, true); }
      } }),
      button('Close', { kind: 'primary', onclick: close })),
  ]);
  d.el.querySelector('.sheet').classList.add('wide');
}

export async function crashes(ctx) {
  const status = ctx.crashStatus || 'open';
  const { groups, open, keepDays, collecting } = await api(`/api/admin/crashes?status=${status}`);
  ctx.setCounts({ crashes: open });

  const filter = h('select', { class: 'input', 'aria-label': 'Show', onchange: (e) => { ctx.crashStatus = e.target.value; ctx.render(); } },
    [['open', 'Open'], ['resolved', 'Fixed'], ['all', 'All']].map(([v, t]) => h('option', { value: v, selected: v === status }, t)));

  return h('div', null,
    pageHead({ title: 'Crashes', actions: [button('Settings', { onclick: () => ctx.go('settings', 'Crash reports') })] }),
    h('div', { class: 'panel' },
      h('div', { class: 'toolbar' }, filter, h('span', { class: 'muted' }, collecting ? `Kept for ${keepDays} days` : 'Collecting is off')),
      groups.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'fixed' },
        h('colgroup', null, ['46%', '12%', '10%', '20%', '12%'].map((w) => h('col', { style: `width:${w}` }))),
        h('thead', null, h('tr', null, ['Crash', 'Times', 'People', 'Last seen', ''].map((t, i) => h('th', { class: i === 1 || i === 2 ? 'r' : '' }, t)))),
        h('tbody', null, groups.map((g) => h('tr', null,
          h('td', null, h('div', null, g.title || '(no message)'), h('div', { class: 'muted' }, sourceName(g.source), g.versions.length ? ` · ${g.versions[0]}` : '', g.resolved ? ' · fixed' : '')),
          h('td', { class: 'num r' }, String(g.count)), h('td', { class: 'num r' }, String(g.people)), h('td', null, ago(g.last)),
          h('td', { class: 'actions' }, button('View', { small: true, onclick: () => openGroup(g, ctx).catch((e) => toast(e.message, true)) })))))))
      : h('div', { class: 'empty' }, status === 'open' ? 'No open crashes' : 'Nothing here')));
}
