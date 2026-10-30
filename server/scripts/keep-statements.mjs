// Local aid for Node 24 (on Windows, better-sqlite3 can crash when it garbage-collects a prepared statement): keep every prepared
// statement alive by caching it per database and SQL text. The Docker image uses Node 22 and does not need this.
//   node --import ./scripts/keep-statements.mjs dist/index.js
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const Database = require('better-sqlite3');
const orig = Database.prototype.prepare;
Database.prototype.prepare = function (sql) {
  this.__cache ??= new Map();
  let st = this.__cache.get(sql);
  if (!st) { st = orig.call(this, sql); this.__cache.set(sql, st); }
  return st;
};
// better-sqlite3's pragma() bypasses the public prepare() wrapper, leaving
// those native statements exposed to the same Node 24 finalizer crash.
const originalPragma = Database.prototype.pragma;
Database.prototype.pragma = function (source, options) {
  if (typeof source !== 'string' || (options != null && typeof options !== 'object') ||
      (options?.simple !== undefined && typeof options.simple !== 'boolean')) {
    return originalPragma.call(this, source, options);
  }
  const statement = this.prepare(`PRAGMA ${source}`);
  if (!statement.reader) { statement.run(); return options?.simple ? undefined : []; }
  statement.pluck(options?.simple === true);
  return options?.simple ? statement.get() : statement.all();
};
