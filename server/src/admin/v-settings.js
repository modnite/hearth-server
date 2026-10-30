import { icon } from './icons.js';
import { api, button, h, megabytes, pageHead, pill, toast } from './ui.js';

/** Checks a value the way the server will, so a mistake shows next to the field at once. */
function check(s, v) {
  if (s.type === 'number') {
    const n = Number(v);
    if (v === '' || !Number.isFinite(n) || !Number.isInteger(n)) return 'Enter a whole number.';
    if (s.min != null && n < s.min) return `At least ${s.min}.`;
    if (s.max != null && n > s.max) return `At most ${s.max}.`;
  }
  if (s.key === 'registrationKey' && v !== '' && v.length < 8) return 'Use 8 or more characters, or leave it empty to switch the house key off.';
  if (s.key === 'livekitUrl' && v !== '' && !/^(wss?|https?):\/\/\S+$/i.test(v)) return 'Start with wss:// or ws://.';
  if (s.key === 'livekitInternalUrl' && v !== '' && !/^https?:\/\/\S+$/i.test(v)) return 'Start with http:// or https://.';
  if (v.length > 500) return 'That is too long.';
  return '';
}

export async function settings(ctx) {
  const { settings: list } = await api('/api/admin/config');
  const groups = [...new Set(list.map((s) => s.group))];
  const initial = new Map(list.map((s) => [s.key, s.type === 'secret' ? '' : (s.value ?? '')]));
  const values = new Map(initial);
  const clear = new Set(); // secrets to remove
  const errors = new Map();
  const fields = new Map(); // key -> { render }
  let bar, barMsg, saveBtn, discardBtn;

  const dirtyKeys = () => list.filter((s) => (s.type === 'secret' ? (clear.has(s.key) || values.get(s.key) !== '') : values.get(s.key) !== initial.get(s.key))).map((s) => s.key);
  const refreshBar = () => {
    const n = dirtyKeys().length;
    bar.classList.toggle('show', n > 0);
    barMsg.textContent = n === 1 ? '1 unsaved change' : `${n} unsaved changes`;
    saveBtn.disabled = [...errors.values()].some(Boolean);
  };
  const set = (s, v) => {
    values.set(s.key, v);
    const msg = check(s, v);
    if (msg) errors.set(s.key, msg); else errors.delete(s.key);
    fields.get(s.key)?.render();
    refreshBar();
  };

  function control(s) {
    const id = `s-${s.key}`;
    const wrap = h('div', { class: 'ctl' });
    const render = () => {
      const v = values.get(s.key);
      const err = errors.get(s.key);
      let ctl;
      if (s.type === 'choice' && s.choices.length === 2 && s.choices.includes('on')) {
        ctl = h('button', { type: 'button', class: 'switch', role: 'switch', id, 'aria-checked': String(v === 'on'), 'aria-label': s.label, onclick: () => set(s, v === 'on' ? 'off' : 'on') });
      } else if (s.type === 'choice') {
        ctl = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': s.label }, s.choices.map((c) => h('label', null, h('input', { type: 'radio', name: id, value: c, checked: c === v, onchange: () => set(s, c) }), h('span', null, c))));
      } else if (s.type === 'secret') {
        const wasSet = s.set && !clear.has(s.key);
        const typing = v !== '' || !wasSet;
        if (!typing) {
          ctl = h('div', { class: 'secret-state' }, pill('Set', 'good'), button('Replace', { small: true, onclick: () => { values.set(s.key, ' '); values.set(s.key, ''); fields.get(s.key).replacing = true; fields.get(s.key).render(); } }), button('Clear', { small: true, kind: 'danger', onclick: () => { clear.add(s.key); values.set(s.key, ''); fields.get(s.key).render(); refreshBar(); } }));
        } else {
          const input = h('input', { class: 'input mono', id, type: 'password', autocomplete: 'new-password', spellcheck: 'false', value: v, placeholder: clear.has(s.key) ? 'Will be cleared on save' : 'Not set', 'aria-invalid': err ? 'true' : null, oninput: (e) => set(s, e.target.value) });
          const reveal = h('button', { type: 'button', class: 'btn quiet sm icon-only reveal', title: 'Show', 'aria-label': 'Show the value', onclick: () => { const show = input.type === 'password'; input.type = show ? 'text' : 'password'; reveal.replaceChildren(icon(show ? 'eyeoff' : 'eye', 'sm')); } }, icon('eye', 'sm'));
          ctl = h('div', { class: 'input-wrap' }, input, reveal);
          if (clear.has(s.key) || fields.get(s.key)?.replacing) ctl = h('div', { style: 'display:grid;gap:8px;width:100%' }, ctl, h('button', { type: 'button', class: 'link', style: 'justify-self:start', onclick: () => { clear.delete(s.key); values.set(s.key, ''); errors.delete(s.key); fields.get(s.key).replacing = false; fields.get(s.key).render(); refreshBar(); } }, 'Keep the current value'));
        }
      } else if (s.type === 'number') {
        const unit = /Mb$/.test(s.key) ? 'MB' : '';
        ctl = h('div', { style: 'display:grid;gap:6px;width:100%' }, h('div', { class: 'input-wrap' }, h('input', { class: 'input num', id, type: 'text', inputmode: 'numeric', value: v, 'aria-invalid': err ? 'true' : null, oninput: (e) => set(s, e.target.value.trim()) }), unit ? h('span', { class: 'suffix' }, unit) : null),
          unit && !err && Number.isFinite(Number(v)) && v !== '' ? h('span', { class: 'hint num', style: 'justify-self:end' }, `= ${megabytes(Number(v))}`) : null);
      } else {
        ctl = h('input', { class: 'input' + (/url|key|public/i.test(s.key) ? ' mono' : ''), id, type: 'text', autocomplete: 'off', spellcheck: 'false', value: v, 'aria-invalid': err ? 'true' : null, oninput: (e) => set(s, e.target.value) });
      }
      wrap.replaceChildren(...[ctl, err ? h('div', { class: 'error-text', role: 'alert' }, icon('alert', 'sm'), err) : null].filter(Boolean));
    };
    fields.set(s.key, { render, replacing: false });
    render();
    return wrap;
  }

  const row = (s) => h('div', { class: 'setting' },
    h('div', null,
      h('div', { class: 'head' }, h('label', { class: 'name', for: `s-${s.key}` }, s.label.replace(/ \(MB\)$/, '')),
        s.source === 'panel' ? pill('Set here', 'accent') : s.source === 'environment' ? pill('From environment') : null,
        s.live ? null : pill('Needs restart', 'warn')),
      s.source === 'panel' ? h('div', { class: 'links' }, h('button', { type: 'button', class: 'link', onclick: async () => {
        try { await api('/api/admin/config', { method: 'PUT', body: { changes: { [s.key]: null } } }); toast('Back to the environment value'); ctx.render(); } catch (e) { toast(e.message, true); }
      } }, 'Use the environment value')) : null),
    control(s));

  async function save() {
    const changes = {};
    for (const s of list) {
      if (s.type === 'secret') { if (values.get(s.key) !== '') changes[s.key] = values.get(s.key); else if (clear.has(s.key)) changes[s.key] = ''; }
      else if (values.get(s.key) !== initial.get(s.key)) changes[s.key] = values.get(s.key);
    }
    if (!Object.keys(changes).length) return;
    saveBtn.disabled = true;
    try {
      const r = await api('/api/admin/config', { method: 'PUT', body: { changes } });
      toast(r.restart ? 'Saved. Some changes apply after a restart.' : 'Saved. It applies now.');
      ctx.state.info = await api('/api/server/info');
      ctx.render();
    } catch (err) {
      saveBtn.disabled = false;
      const hit = list.find((s) => err.message.toLowerCase().includes(s.label.toLowerCase()));
      if (hit) { errors.set(hit.key, err.message); fields.get(hit.key)?.render(); }
      toast(err.message, true);
    }
  }

  const sections = groups.map((g) => h('section', { class: 'group-block', id: `g-${g}`, 'data-group': g },
    h('h2', null, g), h('div', { class: 'panel divided' }, list.filter((s) => s.group === g).map(row))));

  saveBtn = h('button', { type: 'button', class: 'btn primary', onclick: save }, 'Save changes');
  discardBtn = h('button', { type: 'button', class: 'btn quiet', onclick: () => ctx.render() }, 'Discard');
  barMsg = h('span', { class: 'msg num' }, '');
  bar = h('div', { class: 'savebar', role: 'region', 'aria-label': 'Unsaved changes' }, h('div', null, icon('info'), barMsg, discardBtn, saveBtn));

  const toc = h('nav', { class: 'toc', 'aria-label': 'Groups' }, groups.map((g) => h('a', { href: `#settings`, 'data-g': g, onclick: (e) => { e.preventDefault(); document.getElementById(`g-${g}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, g)));
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) toc.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.g === en.target.dataset.group));
  }, { rootMargin: '-20% 0px -70% 0px' });
  queueMicrotask(() => { sections.forEach((s) => io.observe(s)); toc.firstChild?.classList.add('on'); if (ctx.focusGroup) document.getElementById(`g-${ctx.focusGroup}`)?.scrollIntoView({ block: 'start' }); });

  const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's' && dirtyKeys().length) { e.preventDefault(); if (!saveBtn.disabled) save(); } };
  document.addEventListener('keydown', onKey);
  ctx.onLeave(() => { document.removeEventListener('keydown', onKey); io.disconnect(); bar.remove(); });
  document.body.append(bar);
  refreshBar();

  return h('div', { class: 'page fade' },
    pageHead({ title: 'Settings' }),
    h('div', { class: 'settings' }, toc, h('div', null, sections)));
}
