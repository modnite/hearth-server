// One icon set, drawn on a 24px grid with a 1.75px round stroke, so every icon in the panel weighs the same.
const P = {
  overview: '<rect x="4" y="4" width="6.5" height="9" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="5" rx="1.5"/><rect x="13.5" y="12" width="6.5" height="8" rx="1.5"/><rect x="4" y="16" width="6.5" height="4" rx="1.5"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  people: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3 3-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><path d="M15.5 5.6a3 3 0 0 1 0 5.8M17 14.6c2 .5 3.2 2 3.5 4.4"/>',
  invites: '<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h11A2.5 2.5 0 0 1 20 8.5V10a2 2 0 0 0 0 4v1.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 15.5V14a2 2 0 0 0 0-4z"/><path d="M14 6.5v11" stroke-dasharray="1.6 2.4"/>',
  backups: '<rect x="4" y="5" width="16" height="4" rx="1.5"/><path d="M5.5 9v8.5A1.5 1.5 0 0 0 7 19h10a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4"/>',
  activity: '<path d="M3 12h4l2.4-6 4.2 12 2.4-6H21"/>',
  code: '<path d="M8.5 8 4.5 12l4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6.5A2 2 0 0 1 7 4.5h8.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  logout: '<path d="M10 5H6.5A2.5 2.5 0 0 0 4 7.5v9A2.5 2.5 0 0 0 6.5 19H10M15 8l4 4-4 4M19 12H9"/>',
  shield: '<path d="M12 3l7 3v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/>',
  shieldoff: '<path d="M12 3l7 3v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/><path d="M5 5l14 14"/>',
  key: '<circle cx="8" cy="15" r="3.5"/><path d="M10.5 12.5 20 3M16 7l3 3M13.5 9.5 16 12"/>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l.8 12a1 1 0 0 0 1 .9h6.4a1 1 0 0 0 1-.9L17 7M10 11v5M14 11v5"/>',
  power: '<path d="M12 3v9M6.8 6.8a7.5 7.5 0 1 0 10.4 0"/>',
  alert: '<path d="M12 4 21.5 20h-19z"/><path d="M12 10v4.5M12 17.2h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M4 4l16 16M9.9 5.7A9.6 9.6 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a16 16 0 0 1-3.2 3.9M6.1 7.8A16 16 0 0 0 2 12s3.6 6.5 10 6.5c1.5 0 2.8-.3 4-.8M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
  phonecall: '<path d="M5 4h4l1.5 4-2 1.5a11 11 0 0 0 6 6L16 13.5l4 1.5v4a1.5 1.5 0 0 1-1.6 1.5C10 20 4 14 3.5 5.6A1.5 1.5 0 0 1 5 4z"/>',
  bell: '<path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/>',
  globe2: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.8 3.7-5.5 7-5.5s6.2 1.7 7 5.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
};

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
  svg.innerHTML = P[name] || ''; // static strings from this file only
  return svg;
}

/** The Hearth mark: an ember-coloured bubble. */
export function mark() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'mark');
  // Solid fills only: a gradient defined in one SVG and used from another breaks when the first one is display:none (the phone top bar on a desktop).
  svg.innerHTML = '<circle cx="16" cy="16" r="16" fill="#ee5a0c"/><path d="M9.5 10.5h13a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3h-7.2l-4.3 3.6v-3.6h-1.5a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3z" fill="#fff"/><circle cx="16" cy="16" r="2.1" fill="#ee5a0c"/>';
  return svg;
}
