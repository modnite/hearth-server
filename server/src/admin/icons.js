// A small set of plain line icons (16px grid, 1.8 stroke). Static strings only.
const P = {
  overview: '<rect x="2.5" y="2.5" width="4.5" height="6" rx="1"/><rect x="9" y="2.5" width="4.5" height="3.5" rx="1"/><rect x="9" y="8" width="4.5" height="5.5" rx="1"/><rect x="2.5" y="10.5" width="4.5" height="3" rx="1"/>',
  settings: '<path d="M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6"/><circle cx="10" cy="5" r="1.5"/><circle cx="6" cy="11" r="1.5"/>',
  people: '<circle cx="6" cy="5.5" r="2.2"/><path d="M2 13c.4-2.2 2-3.3 4-3.3s3.6 1.1 4 3.3"/><path d="M10.5 3.6a2.2 2.2 0 0 1 0 3.8M12 9.9c1.2.4 1.9 1.4 2 3"/>',
  invites: '<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h9A1.5 1.5 0 0 1 14 5.5V7a1.2 1.2 0 0 0 0 2v1.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 10.5V9a1.2 1.2 0 0 0 0-2z"/>',
  backups: '<rect x="2" y="3" width="12" height="3" rx="1"/><path d="M3 6v6.2a.8.8 0 0 0 .8.8h8.4a.8.8 0 0 0 .8-.8V6M6.5 9h3"/>',
  activity: '<path d="M1.5 8h3l1.6-4 3.2 8 1.6-4h3.6"/>',
  code: '<path d="M5.5 5 2.5 8l3 3M10.5 5l3 3-3 3M9 3.5l-2 9"/>',
  calls: '<path d="M3.5 2.5h2.2l1 2.6-1.4 1a7 7 0 0 0 3.6 3.6l1-1.4 2.6 1v2.2a1 1 0 0 1-1.1 1C6.4 12 3 8.6 2.5 3.6a1 1 0 0 1 1-1.1z"/>',
  push: '<path d="M4 11V7.5a4 4 0 1 1 8 0V11l1 1.5H3zM6.5 14a1.5 1.5 0 0 0 3 0"/>',
  browser: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2C6 4 6 12 8 14"/>',
  database: '<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
  server: '<rect x="2" y="3" width="12" height="4" rx="1"/><rect x="2" y="9" width="12" height="4" rx="1"/><path d="M4.5 5h.01M4.5 11h.01"/>',
  msg: '<path d="M3 3.5h10a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  shield: '<path d="M8 1.8l5 2v4.2c0 3-2 5.2-5 6.2-3-1-5-3.2-5-6.2V3.8z"/>',
  menu: '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>',
  user: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.5-2.6 2.6-3.8 5-3.8s4.5 1.2 5 3.8"/>',
  logout: '<path d="M6.5 3H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13h2.5M10 5l3 3-3 3M13 8H6"/>',
  sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>',
  moon: '<path d="M13.5 9.8A5.5 5.5 0 0 1 6.2 2.5a5.5 5.5 0 1 0 7.3 7.3z"/>',
};
export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
  svg.innerHTML = P[name] || '';
  return svg;
}
