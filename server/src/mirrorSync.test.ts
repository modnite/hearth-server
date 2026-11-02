import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applySnapshot, diffFiles, exportSnapshot, safePath } from './mirrorSync.js';

const dirs: string[] = [];
const opened: Database.Database[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-sync-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of opened.splice(0)) d.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function open(dir: string, name: string): Database.Database {
  const db = new Database(path.join(dir, name));
  opened.push(db);
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, extra TEXT NOT NULL DEFAULT 'x'); CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT);");
  return db;
}

describe('copying a database', () => {
  it('replaces every table with the snapshot, inside the live connection', () => {
    const dir = tmp();
    const main = open(dir, 'main.db');
    main.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('old', 'Old');
    const other = open(dir, 'other.db');
    other.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('a', 'Alice');
    other.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('b', 'Bob');
    exportSnapshot(other, path.join(dir, 'snap.db'));
    const r = applySnapshot(main, path.join(dir, 'snap.db'));
    expect(r.rows).toBe(2);
    expect(main.prepare('SELECT id FROM users ORDER BY id').all()).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('keeps the sessions made on this server itself', () => {
    const dir = tmp();
    const main = open(dir, 'main.db');
    main.prepare('INSERT INTO sessions VALUES (?, ?)').run('mine', 'u');
    main.prepare('INSERT INTO sessions VALUES (?, ?)').run('stale', 'u');
    const other = open(dir, 'other.db');
    other.prepare('INSERT INTO sessions VALUES (?, ?)').run('theirs', 'u');
    exportSnapshot(other, path.join(dir, 'snap.db'));
    applySnapshot(main, path.join(dir, 'snap.db'), new Set(['mine']));
    expect(main.prepare('SELECT token FROM sessions ORDER BY token').all()).toEqual([{ token: 'mine' }, { token: 'theirs' }]);
  });

  it('copes with a column the other side does not have', () => {
    const dir = tmp();
    const main = open(dir, 'main.db');
    const other = new Database(path.join(dir, 'other.db'));
    opened.push(other);
    other.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO users VALUES ('a', 'Alice');");
    exportSnapshot(other, path.join(dir, 'snap.db'));
    applySnapshot(main, path.join(dir, 'snap.db'));
    expect(main.prepare('SELECT id, name, extra FROM users').all()).toEqual([{ id: 'a', name: 'Alice', extra: 'x' }]);
  });
});

describe('copying files', () => {
  it('fetches what is new or a different size and removes what is gone', () => {
    const local = [{ p: 'uploads/a', s: 1, m: 1 }, { p: 'uploads/b', s: 2, m: 1 }, { p: 'uploads/gone', s: 1, m: 1 }];
    const remote = [{ p: 'uploads/a', s: 1, m: 9 }, { p: 'uploads/b', s: 3, m: 9 }, { p: 'uploads/new', s: 5, m: 9 }];
    const d = diffFiles(local, remote);
    expect(d.fetch.map((f) => f.p)).toEqual(['uploads/b', 'uploads/new']);
    expect(d.remove).toEqual(['uploads/gone']);
  });

  it('only accepts paths inside the shared folders', () => {
    const base = path.resolve('/data');
    expect(safePath(base, 'uploads/x.png')).toBe(path.join(base, 'uploads', 'x.png'));
    expect(safePath(base, 'backups/u1/file.bin')).toBe(path.join(base, 'backups', 'u1', 'file.bin'));
    for (const bad of ['../etc/passwd', 'uploads/../../x', 'config.json', 'uploads', 'uploads//x', '/uploads/x', 'uploads\\x', 'mirror.json']) expect(safePath(base, bad)).toBeNull();
  });
});
