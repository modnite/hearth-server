import { attachLegacyBridge } from './legacyBridge.js';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { registerAdmin, collectRoutes, SOFTWARE, VERSION } from './admin.js';
import { hashPassword, purgeExpiredSessions } from './auth.js';
import { db, now } from './db.js';
import { env } from './env.js';
import { hub } from './realtime.js';
import { registerRoutes } from './routes.js';
import { staticCacheHeaders } from './staticCache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
  trustProxy: true,
  bodyLimit: 5 * 1024 * 1024,
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 1 } });

app.get('/api/health', async () => ({ ok: true, uptime: process.uptime() }));

const routeList = collectRoutes(app);
registerRoutes(app);
registerAdmin(app, { routes: routeList });
hub.attach(app);
attachLegacyBridge(app, hub);
hub.log = { debug: (o, msg) => app.log.debug(o as object, msg), info: (o, msg) => app.log.info(o as object, msg) };

const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    index: ['index.html'],
    // Cache rules. Hashed bundles never change; the ~3.8k emoji and the buddy sprites rarely do. With
    // max-age=0 on everything, every emoji and chunk cost a conditional round trip on each load (many of
    // them queued behind a browser's six connections per host: slow, especially in Safari).
    cacheControl: false,
    setHeaders(res, filePath) {
      for (const [name, value] of Object.entries(staticCacheHeaders(filePath))) res.setHeader(name, value);
    },
  });
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? '';
    if (url.startsWith('/api') || url.startsWith('/ws')) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    reply.headers(staticCacheHeaders('/index.html')).type('text/html').send(fs.createReadStream(path.join(publicDir, 'index.html')));
  });
} else {
  // No web client is bundled: this server is the API that clients (Ember, the web app, your own) talk to.
  app.get('/', async () => ({
    ok: true,
    service: SOFTWARE,
    version: VERSION,
    admin: '/admin',
    info: '/api/server/info',
    docs: 'https://github.com/modnite/hearth-server/blob/main/docs/API.md',
  }));
}

function ensureFirstUser(): void {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (n > 0) return;
  if (!env.FIRST_USER_USERNAME || !env.FIRST_USER_PASSWORD) {
    app.log.warn(
      'No users yet. Open /admin in a browser to create the first administrator (or set FIRST_USER_USERNAME and FIRST_USER_PASSWORD).',
    );
    return;
  }
  const id = nanoid();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, avatar_color, status, status_message, created_at, is_admin)
     VALUES (?, ?, ?, ?, ?, 'offline', '', ?, 1)`,
  ).run(
    id,
    env.FIRST_USER_USERNAME,
    env.FIRST_USER_DISPLAY_NAME || env.FIRST_USER_USERNAME,
    hashPassword(env.FIRST_USER_PASSWORD),
    '#7c6cff',
    now(),
  );
  app.log.info(`created the first account: ${env.FIRST_USER_USERNAME}`);
}

ensureFirstUser();
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 60 * 60_000).unref();

await app.listen({ port: env.PORT, host: '0.0.0.0' });
app.log.info(`Hearth ready on port ${env.PORT} (domain ${env.HEARTH_DOMAIN})`);

// Calls live in the media engine, not in our memory: after a restart (a
// deploy, a reboot) any room still carrying media is adopted back, so nobody
// loses a call that is actually still going. Retried briefly at boot because
// the media engine may still be starting up.
void (async () => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const restored = await hub.restoreCalls();
      if (restored > 0) app.log.info(`adopted ${restored} live call(s) from the media engine`);
    } catch (err) {
      app.log.warn({ err }, 'could not restore live calls');
    }
    if (attempt < 5) await new Promise((r) => setTimeout(r, 3000));
  }
})();
