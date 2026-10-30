import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const k of ['SESSION_SECRET', 'LIVEKIT_API_SECRET', 'LIVEKIT_API_KEY', 'LIVEKIT_KEYS_FILE', 'NODE_ENV']) delete process.env[k];
  Object.assign(process.env, { DATA_DIR: dir }, env);
  return import('./selfConfigure.js');
}
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-self-')); });

describe('selfConfigure', () => {
  it('makes a session secret once in production and keeps it', async () => {
    await load({ NODE_ENV: 'production' });
    const first = process.env.SESSION_SECRET!;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(path.join(dir, 'session.secret'), 'utf8')).toBe(first);
    await load({ NODE_ENV: 'production' });
    expect(process.env.SESSION_SECRET).toBe(first);
  });

  it('leaves a session secret that was given alone', async () => {
    await load({ NODE_ENV: 'production', SESSION_SECRET: 'given-by-the-operator-0123456789' });
    expect(process.env.SESSION_SECRET).toBe('given-by-the-operator-0123456789');
    expect(fs.existsSync(path.join(dir, 'session.secret'))).toBe(false);
  });

  it('does not write anything in development', async () => {
    await load({ NODE_ENV: 'development' });
    expect(fs.existsSync(path.join(dir, 'session.secret'))).toBe(false);
  });

  it('reads the LiveKit key from the shared file when none was given', async () => {
    const keys = path.join(dir, 'livekit.keys');
    fs.writeFileSync(keys, 'hearth: abc123:with-colon\n');
    await load({ LIVEKIT_KEYS_FILE: keys });
    expect(process.env.LIVEKIT_API_KEY).toBe('hearth');
    expect(process.env.LIVEKIT_API_SECRET).toBe('abc123:with-colon');
  });

  it('prefers a LiveKit secret that was given', async () => {
    const keys = path.join(dir, 'livekit.keys');
    fs.writeFileSync(keys, 'hearth: from-file\n');
    await load({ LIVEKIT_KEYS_FILE: keys, LIVEKIT_API_SECRET: 'given' });
    expect(process.env.LIVEKIT_API_SECRET).toBe('given');
  });

  it('copes with no shared file at all', async () => {
    await load({ LIVEKIT_KEYS_FILE: path.join(dir, 'nope') });
    expect(process.env.LIVEKIT_API_SECRET).toBeUndefined();
  });
});
