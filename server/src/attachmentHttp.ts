/** Pure helpers for serving attachments: headers and byte ranges. */

/** RFC 5987 percent-encoding: encodeURIComponent leaves ' ( ) * alone, which filename* does not allow. */
function encode5987(s: string): string {
  return encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Content-Disposition with an ASCII fallback `filename` and a UTF-8 `filename*`. */
export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const name = filename.replace(/[\r\n]+/g, ' ') || 'file';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encode5987(name)}`;
}

/**
 * Parse a single-range `Range: bytes=...` header.
 * Returns null when there is no (usable) range, 'unsatisfiable' when it lies outside the file.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // multi-range or junk: serve the whole file
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
