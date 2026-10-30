import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Backups kept on this Hearth server, one folder per person. A client (Ember) puts, lists, fetches and deletes its own backup files here, so a
 * new phone can find them the moment the person signs in. The files are sealed on the device before they arrive: the server stores opaque bytes
 * and cannot read them. Limits: BACKUP_MAX_FILE_MB per file (default 1024) and BACKUP_QUOTA_MB per person (default 4096); BACKUP_STORAGE=off
 * turns this off.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const MB = 1024 * 1024;

export interface ServerBackupDeps {
  requireUser: (req: FastifyRequest, reply: FastifyReply) => { id: string } | null;
  dataDir: string;
}

export interface BackupLimits {
  maxFile: number;
  quota: number;
}

export function backupLimits(env: NodeJS.ProcessEnv = process.env): BackupLimits {
  return { maxFile: Number(env.BACKUP_MAX_FILE_MB || 1024) * MB, quota: Number(env.BACKUP_QUOTA_MB || 4096) * MB };
}

export const validBackupName = (name: unknown): name is string => typeof name === 'string' && NAME.test(name);

/** What is stored for one person. */
export function listBackups(dir: string): Array<{ name: string; size: number; modifiedAt: number }> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => validBackupName(n) && !n.endsWith('.part'))
    .map((n) => {
      const st = fs.statSync(path.join(dir, n));
      return { name: n, size: st.size, modifiedAt: Math.round(st.mtimeMs) };
    })
    .filter((f) => f.size >= 0)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export const usedBytes = (dir: string): number => listBackups(dir).reduce((n, f) => n + f.size, 0);

export function registerServerBackups(app: FastifyInstance, deps: ServerBackupDeps): void {
  // Read per request so the admin panel's switch and limits apply at once.
  const off = () => (process.env.BACKUP_STORAGE ?? '').toLowerCase() === 'off';
  app.addHook('onRequest', async (req, reply) => {
    if (off() && req.url.startsWith('/api/backup/files')) return reply.code(404).send({ error: 'this server does not keep backups' });
  });
  const dirOf = (userId: string) => path.join(deps.dataDir, 'backups', userId.replace(/[^A-Za-z0-9_-]/g, '_'));

  // The file arrives as a raw body; keep it a stream so a large backup is never held in memory.
  if (!app.hasContentTypeParser('application/octet-stream')) {
    app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
  }

  app.get('/api/backup/files', async (req, reply) => {
    const me = deps.requireUser(req, reply);
    if (!me) return;
    const dir = dirOf(me.id);
    return { files: listBackups(dir), quota: { used: usedBytes(dir), limit: backupLimits().quota, maxFile: backupLimits().maxFile } };
  });

  app.put('/api/backup/files/:name', { bodyLimit: 1024 ** 4 }, async (req, reply) => {
    const me = deps.requireUser(req, reply);
    if (!me) return;
    const name = (req.params as { name: string }).name;
    if (!validBackupName(name)) return reply.code(400).send({ error: 'that file name is not allowed' });
    const body = req.body as NodeJS.ReadableStream | undefined;
    if (!body || typeof (body as { pipe?: unknown }).pipe !== 'function') return reply.code(415).send({ error: 'send the file as application/octet-stream' });
    const dir = dirOf(me.id);
    fs.mkdirSync(dir, { recursive: true });
    const final = path.join(dir, name);
    const part = path.join(dir, `${name}.${process.pid}.part`);
    const replacing = fs.existsSync(final) ? fs.statSync(final).size : 0;
    let written = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        written += chunk.length;
        if (written > backupLimits().maxFile) return cb(new Error('too large'));
        if (usedBytes(dir) - replacing + written > backupLimits().quota) return cb(new Error('over quota'));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, counter, fs.createWriteStream(part));
    } catch (e) {
      fs.rmSync(part, { force: true });
      const reason = (e as Error).message;
      if (reason === 'too large') return reply.code(413).send({ error: 'that file is larger than this server allows' });
      if (reason === 'over quota') return reply.code(507).send({ error: 'your backup space on this server is full' });
      return reply.code(400).send({ error: 'the upload did not finish' });
    }
    fs.renameSync(part, final);
    return { ok: true, size: written };
  });

  app.get('/api/backup/files/:name', async (req, reply) => {
    const me = deps.requireUser(req, reply);
    if (!me) return;
    const name = (req.params as { name: string }).name;
    if (!validBackupName(name)) return reply.code(400).send({ error: 'that file name is not allowed' });
    const file = path.join(dirOf(me.id), name);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'not found' });
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(fs.statSync(file).size))
      .header('cache-control', 'no-store')
      .send(fs.createReadStream(file));
  });

  app.delete('/api/backup/files/:name', async (req, reply) => {
    const me = deps.requireUser(req, reply);
    if (!me) return;
    const name = (req.params as { name: string }).name;
    if (!validBackupName(name)) return reply.code(400).send({ error: 'that file name is not allowed' });
    fs.rmSync(path.join(dirOf(me.id), name), { force: true });
    return { ok: true };
  });
}
