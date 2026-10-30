import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { db, now } from './db.js';

/**
 * Crash reports from clients (Ember, the web app, anything else that wants to send them). A report is one occurrence; occurrences with the
 * same signature (exception type, message shape and top frames) form a group, and the group is what an administrator reviews, marks as
 * fixed, or deletes. A new occurrence of a group marked fixed reopens it.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS crash_reports (
  id          TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,
  client_at   INTEGER,
  source      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  app_version TEXT NOT NULL DEFAULT '',
  platform    TEXT NOT NULL DEFAULT '',
  device      TEXT NOT NULL DEFAULT '',
  signature   TEXT NOT NULL,
  message     TEXT NOT NULL,
  stack       TEXT NOT NULL DEFAULT '',
  context     TEXT NOT NULL DEFAULT '',
  user_id     TEXT
);
CREATE INDEX IF NOT EXISTS crash_reports_signature ON crash_reports (signature, at);
CREATE INDEX IF NOT EXISTS crash_reports_at ON crash_reports (at);
CREATE TABLE IF NOT EXISTS crash_state (
  signature  TEXT PRIMARY KEY,
  resolved   INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
`);

export const LIMITS = { message: 2000, stack: 24_000, context: 4000, version: 40, platform: 80, device: 80, maxRows: 5000 };

export const KINDS = ['crash', 'error', 'anr'] as const;
export type CrashKind = (typeof KINDS)[number];

export interface CrashInput {
  source: string;
  kind: CrashKind;
  appVersion: string;
  platform: string;
  device: string;
  message: string;
  stack: string;
  context: string;
  clientAt: number | null;
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\u0000/g, '').slice(0, max) : '');

/** Check what a client sent. Returns the cleaned report, or a sentence saying what is wrong. */
export function parseReport(body: unknown): CrashInput | string {
  if (!body || typeof body !== 'object') return 'send a JSON object';
  const b = body as Record<string, unknown>;
  const source = text(b.source, 20).toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,19}$/.test(source)) return 'source must be a short name such as ember or web';
  const message = text(b.message, LIMITS.message).trim();
  if (!message) return 'a crash report needs a message';
  const kind = (KINDS as readonly string[]).includes(String(b.kind)) ? (b.kind as CrashKind) : 'crash';
  let context = '';
  if (b.context && typeof b.context === 'object') {
    try {
      const json = JSON.stringify(b.context);
      if (json.length <= LIMITS.context) context = json;
    } catch {
      /* not serialisable: left out */
    }
  }
  const clientAt = typeof b.at === 'number' && Number.isFinite(b.at) && b.at > 0 ? Math.round(b.at) : null;
  return {
    source,
    kind,
    appVersion: text(b.appVersion, LIMITS.version),
    platform: text(b.platform, LIMITS.platform),
    device: text(b.device, LIMITS.device),
    message,
    stack: text(b.stack, LIMITS.stack),
    context,
    clientAt,
  };
}

/** The part of a stack line that survives a rebuild: no file, line or column. */
function frameName(line: string): string {
  return line
    .trim()
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/@.*$/, '')
    .replace(/:\d+(:\d+)?$/, '')
    .replace(/\d+/g, 'N')
    .slice(0, 120);
}

/** Same crash, same signature: exception text with numbers blurred, plus the first three frames by name. */
export function signatureOf(source: string, message: string, stack: string): string {
  const head = (message.split('\n')[0] ?? '').replace(/0x[0-9a-f]+/gi, '0x').replace(/\d+/g, 'N').slice(0, 160);
  const frames = stack
    .split('\n')
    .filter((l) => /^\s*(at |Caused by|[^\s(]+@)/.test(l))
    .slice(0, 3)
    .map(frameName);
  return crypto.createHash('sha256').update([source, head, ...frames].join('|')).digest('hex').slice(0, 16);
}

export function storeReport(input: CrashInput, userId: string | null): { id: string; signature: string } {
  const signature = signatureOf(input.source, input.message, input.stack);
  const id = nanoid(12);
  db.prepare(
    `INSERT INTO crash_reports (id, at, client_at, source, kind, app_version, platform, device, signature, message, stack, context, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, now(), input.clientAt, input.source, input.kind, input.appVersion, input.platform, input.device, signature, input.message, input.stack, input.context, userId);
  // A group marked fixed that crashes again is not fixed.
  db.prepare('UPDATE crash_state SET resolved = 0, updated_at = ? WHERE signature = ? AND resolved = 1').run(now(), signature);
  return { id, signature };
}

export interface CrashGroup {
  signature: string;
  source: string;
  kind: string;
  title: string;
  count: number;
  people: number;
  first: number;
  last: number;
  versions: string[];
  resolved: boolean;
  note: string;
}

type GroupFilter = { status?: 'open' | 'resolved' | 'all'; source?: string };

export function listGroups(filter: GroupFilter = {}): CrashGroup[] {
  const rows = db
    .prepare(
      `SELECT r.signature AS signature, MIN(r.source) AS source, MIN(r.kind) AS kind, COUNT(*) AS count, COUNT(DISTINCT r.user_id) AS people,
              MIN(r.at) AS first, MAX(r.at) AS last, COALESCE(s.resolved, 0) AS resolved, COALESCE(s.note, '') AS note
       FROM crash_reports r LEFT JOIN crash_state s ON s.signature = r.signature
       ${filter.source ? 'WHERE r.source = ?' : ''}
       GROUP BY r.signature ORDER BY MAX(r.at) DESC LIMIT 500`,
    )
    .all(...(filter.source ? [filter.source] : [])) as Array<Omit<CrashGroup, 'title' | 'versions' | 'resolved'> & { resolved: number }>;
  const latest = db.prepare('SELECT message FROM crash_reports WHERE signature = ? ORDER BY at DESC LIMIT 1');
  const versions = db.prepare("SELECT app_version AS v FROM crash_reports WHERE signature = ? AND app_version != '' GROUP BY app_version ORDER BY MAX(at) DESC LIMIT 5");
  return rows
    .map((r) => ({
      ...r,
      resolved: r.resolved === 1,
      title: ((latest.get(r.signature) as { message: string } | undefined)?.message ?? '').split('\n')[0]!.slice(0, 200),
      versions: (versions.all(r.signature) as Array<{ v: string }>).map((x) => x.v),
    }))
    .filter((g) => (filter.status === 'open' ? !g.resolved : filter.status === 'resolved' ? g.resolved : true));
}

export interface CrashOccurrence {
  id: string;
  at: number;
  clientAt: number | null;
  kind: string;
  appVersion: string;
  platform: string;
  device: string;
  message: string;
  stack: string;
  context: unknown;
  user: string | null;
}

export function groupDetail(signature: string, limit = 25): { group: CrashGroup; reports: CrashOccurrence[] } | null {
  const group = listGroups({ status: 'all' }).find((g) => g.signature === signature);
  if (!group) return null;
  const rows = db
    .prepare(
      `SELECT r.id, r.at, r.client_at AS clientAt, r.kind, r.app_version AS appVersion, r.platform, r.device, r.message, r.stack, r.context, u.username AS user
       FROM crash_reports r LEFT JOIN users u ON u.id = r.user_id WHERE r.signature = ? ORDER BY r.at DESC LIMIT ?`,
    )
    .all(signature, Math.min(100, Math.max(1, limit))) as Array<Omit<CrashOccurrence, 'context'> & { context: string }>;
  return {
    group,
    reports: rows.map((r) => {
      let context: unknown = null;
      try {
        context = r.context ? JSON.parse(r.context) : null;
      } catch {
        /* stored text that is not JSON: shown as nothing */
      }
      return { ...r, context };
    }),
  };
}

export function setResolved(signature: string, resolved: boolean, note = ''): boolean {
  if (!db.prepare('SELECT 1 FROM crash_reports WHERE signature = ? LIMIT 1').get(signature)) return false;
  db.prepare(
    `INSERT INTO crash_state (signature, resolved, note, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(signature) DO UPDATE SET resolved = excluded.resolved, note = excluded.note, updated_at = excluded.updated_at`,
  ).run(signature, resolved ? 1 : 0, note.slice(0, 500), now());
  return true;
}

export function deleteGroup(signature: string): number {
  db.prepare('DELETE FROM crash_state WHERE signature = ?').run(signature);
  return db.prepare('DELETE FROM crash_reports WHERE signature = ?').run(signature).changes;
}

export function openGroupCount(): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT r.signature FROM crash_reports r LEFT JOIN crash_state s ON s.signature = r.signature
         GROUP BY r.signature HAVING COALESCE(MAX(s.resolved), 0) = 0)`,
      )
      .get() as { n: number }
  ).n;
}

/** Drop reports older than [days], and the oldest beyond [maxRows]. */
export function pruneReports(days: number, maxRows = LIMITS.maxRows): number {
  let gone = db.prepare('DELETE FROM crash_reports WHERE at < ?').run(now() - days * 86_400_000).changes;
  gone += db
    .prepare('DELETE FROM crash_reports WHERE id IN (SELECT id FROM crash_reports ORDER BY at DESC LIMIT -1 OFFSET ?)')
    .run(maxRows).changes;
  db.prepare('DELETE FROM crash_state WHERE signature NOT IN (SELECT DISTINCT signature FROM crash_reports)').run();
  return gone;
}
