import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// No setup needed to start. A session secret that was not given is made once and kept in the data folder; the LiveKit key made by the
// stack's init service (compose.yml) is read from the shared volume when it was not given either.
export function selfConfigure(): void {
  const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
  const given = process.env.SESSION_SECRET;
  if (!given || given === 'dev-session-secret-change-me') {
    if (process.env.NODE_ENV === 'production') {
      const file = path.join(dataDir, 'session.secret');
      try {
        process.env.SESSION_SECRET = fs.readFileSync(file, 'utf8').trim();
      } catch {
        fs.mkdirSync(dataDir, { recursive: true });
        const made = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(file, made, { mode: 0o600 });
        process.env.SESSION_SECRET = made;
      }
    }
  }
  const keysFile = process.env.LIVEKIT_KEYS_FILE ?? '/shared/livekit.keys';
  if (!process.env.LIVEKIT_API_SECRET) {
    try {
      const [key, ...rest] = fs.readFileSync(keysFile, 'utf8').trim().split(':');
      const secret = rest.join(':').trim();
      if (key && secret) { process.env.LIVEKIT_API_KEY = key.trim(); process.env.LIVEKIT_API_SECRET = secret; }
    } catch { /* no shared keys: calls stay unconfigured */ }
  }
}

selfConfigure();
