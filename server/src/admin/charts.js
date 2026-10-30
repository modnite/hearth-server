// Two small charts drawn as inline SVG (no library): a filled line for a short history, and a ring for shares of a whole.
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

/** A line over time. `points` are numbers; the line fills down to the bottom. */
export function sparkline(points, { width = 240, height = 56, min = 0, max } = {}) {
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, class: 'spark', role: 'img', 'aria-label': 'History', preserveAspectRatio: 'none' });
  const data = points.length > 1 ? points : [points[0] ?? 0, points[0] ?? 0];
  const hi = max ?? Math.max(1, ...data) * 1.15;
  const x = (i) => (i / (data.length - 1)) * width;
  const y = (v) => height - 2 - ((v - min) / (hi - min || 1)) * (height - 6);
  for (let g = 1; g < 4; g++) svg.append(el('line', { x1: 0, x2: width, y1: (height / 4) * g, y2: (height / 4) * g, class: 'grid' }));
  const line = data.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  svg.append(el('path', { d: `${line} L${width} ${height} L0 ${height} Z`, class: 'area' }), el('path', { d: line, class: 'line' }));
  return svg;
}

/** A ring split into shares. `parts` are { value, color }. */
export function ring(parts, { size = 120, thickness = 16 } = {}) {
  const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, class: 'ring', role: 'img' });
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  svg.append(el('circle', { cx: size / 2, cy: size / 2, r, class: 'ring-bg', 'stroke-width': thickness }));
  const total = parts.reduce((n, p) => n + p.value, 0);
  let offset = 0;
  if (total > 0) for (const p of parts) {
    if (p.value <= 0) continue;
    const len = (p.value / total) * c;
    const seg = el('circle', { cx: size / 2, cy: size / 2, r, class: 'ring-seg', 'stroke-width': thickness, 'stroke-dasharray': `${Math.max(len - 1.5, 0.5)} ${c}`, 'stroke-dashoffset': -offset, transform: `rotate(-90 ${size / 2} ${size / 2})` });
    seg.style.setProperty('stroke', p.color);
    svg.append(seg);
    offset += len;
  }
  return svg;
}
