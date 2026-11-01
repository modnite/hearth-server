import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type Database from 'better-sqlite3';

/**
 * The data side of a mirror: copy a whole database from one server to another, and the files that go with it. It is deliberately dumb. The
 * database is small next to the files, so a mirror takes a complete snapshot (SQLite's own VACUUM INTO, which is consistent while the server
 * runs) and replaces its tables with it inside one transaction on the live connection: no restart, and readers never see half of it.
 */

/** Folders of DATA_DIR that hold people's files. Everything else in DATA_DIR is local to a server. */
export const FILE_ROOTS = ['uploads', 'backups'] as const;

export interface RemoteFile {
  /** Path inside DATA_DIR, with forward slashes. */
  p: string;
  /** Size in bytes. */
  s: number;
  /** Modified time in ms. */
  m: number;
}

/** Sign-in tokens made on this server itself (to a mirror's panel), kept when a snapshot replaces the table. */
export const localSessions = new Set<string>();

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export function exportSnapshot(db: Database.Database, dest: string): void {
  fs.rmSync(dest, { force: true });
  db.prepare('VACUUM INTO ?').run(dest);
}

/** Changes made by this connection, a cheap "did anything change" number. Not stable across restarts, so the caller adds a boot id. */
export const changeCount = (db: Database.Database): number => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;

export interface ApplyResult {
  tables: number;
  rows: number;
}

/**
 * Replace the contents of every table in `db` with the same table in the snapshot file. Columns are matched by name, so a snapshot from a
 * slightly older or newer server still applies (a column the snapshot lacks takes its default). `keepSessions` are sign-in tokens made on
 * this server since the snapshot was taken, kept so an administrator signed in to a mirror's panel is not signed out by every sync.
 */
export function applySnapshot(db: Database.Database, file: string, keepSessions: ReadonlySet<string> = new Set()): ApplyResult {
  db.pragma('foreign_keys = OFF');
  db.prepare('ATTACH DATABASE ? AS snap').run(file);
  let tables = 0;
  let rows = 0;
  try {
    const user = (schema: string): string[] =>
      (db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>).map((r) => r.name);
    const columns = (schema: string, table: string): string[] =>
      (db.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(table, schema) as Array<{ name: string }>).map((c) => c.name);
    const remote = new Set(user('snap'));
    const local = user('main');
    const work = db.transaction(() => {
      for (const table of local) {
        const t = quote(table);
        const keep = table === 'sessions' && keepSessions.size > 0 ? [...keepSessions] : [];
        if (keep.length > 0) db.prepare(`DELETE FROM main.${t} WHERE token NOT IN (${keep.map(() => '?').join(',')})`).run(...keep);
        else db.exec(`DELETE FROM main.${t}`);
        if (!remote.has(table)) continue;
        const theirs = new Set(columns('snap', table));
        const common = columns('main', table).filter((c) => theirs.has(c)).map(quote).join(', ');
        if (!common) continue;
        db.exec(`INSERT OR IGNORE INTO main.${t} (${common}) SELECT ${common} FROM snap.${t}`);
        tables += 1;
        rows += (db.prepare(`SELECT COUNT(*) AS n FROM main.${t}`).get() as { n: number }).n;
      }
    });
    work();
  } finally {
    db.exec('DETACH DATABASE snap');
    db.pragma('foreign_keys = ON');
  }
  return { tables, rows };
}

/** Every file under the shared folders. */
export function listFiles(dataDir: string): RemoteFile[] {
  const out: RemoteFile[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (depth < 6) walk(path.join(dir, e.name), r, depth + 1);
      } else if (e.isFile() && !e.name.endsWith('.part')) {
        try {
          const st = fs.statSync(path.join(dir, e.name));
          out.push({ p: r, s: st.size, m: Math.round(st.mtimeMs) });
        } catch {
          /* gone while listing */
        }
      }
    }
  };
  for (const root of FILE_ROOTS) walk(path.join(dataDir, root), root, 0);
  return out;
}

/** The files to fetch (new or a different size) and the local files that no longer exist on the other side. */
export function diffFiles(local: RemoteFile[], remote: RemoteFile[]): { fetch: RemoteFile[]; remove: string[] } {
  const mine = new Map(local.map((f) => [f.p, f]));
  const theirs = new Set(remote.map((f) => f.p));
  return { fetch: remote.filter((f) => mine.get(f.p)?.s !== f.s), remove: local.filter((f) => !theirs.has(f.p)).map((f) => f.p) };
}

/** A path from another server, turned into one inside DATA_DIR, or null when it points anywhere it should not. */
export function safePath(dataDir: string, p: string): string | null {
  if (typeof p !== 'string' || p.includes('\0') || p.includes('\\')) return null;
  const parts = p.split('/');
  if (parts.length < 2 || !FILE_ROOTS.includes(parts[0] as (typeof FILE_ROOTS)[number])) return null;
  if (parts.some((x) => x === '' || x === '.' || x === '..')) return null;
  const full = path.join(dataDir, ...parts);
  return full.startsWith(path.join(dataDir, parts[0]!) + path.sep) ? full : null;
}

/** Fetch one file into place: written beside it first, then renamed, so a reader never sees half a file. */
export async function storeFile(dataDir: string, f: RemoteFile, body: ReadableStream<Uint8Array> | null): Promise<void> {
  const full = safePath(dataDir, f.p);
  if (!full || !body) throw new Error('bad file');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const part = `${full}.${process.pid}.part`;
  try {
    await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(part));
    fs.renameSync(part, full);
    try {
      fs.utimesSync(full, new Date(), new Date(f.m));
    } catch {
      /* the time is a nicety */
    }
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
}

/** Keep only the newest `keep` files of a folder (the dated copies of a database that was replaced). */
export function pruneOld(dir: string, keep: number): void {
  try {
    const files = fs
      .readdirSync(dir)
      .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const f of files.slice(keep)) fs.rmSync(path.join(dir, f.n), { force: true });
  } catch {
    /* nothing to prune */
  }
}
