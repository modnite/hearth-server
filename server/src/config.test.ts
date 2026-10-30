import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;

async function load(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const k of ['REGISTRATION', 'REGISTRATION_KEY', 'BACKUP_QUOTA_MB', 'HEARTH_NAME', 'BROWSE_PROXY', 'LIVEKIT_API_SECRET']) delete process.env[k];
  Object.assign(process.env, env, { DATA_DIR: dir });
  return import('./config.js');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-config-'));
});

describe('config', () => {
  it('uses the default, then the environment, then a value saved in the panel', async () => {
    let c = await load();
    expect(c.cfg('serverName')).toBe('Hearth');
    expect(c.sourceOf('serverName')).toBe('default');
    c = await load({ HEARTH_NAME: 'Home' });
    expect(c.cfg('serverName')).toBe('Home');
    expect(c.sourceOf('serverName')).toBe('environment');
    c.updateConfig({ serverName: 'Panel name' });
    expect(c.cfg('serverName')).toBe('Panel name');
    expect(c.sourceOf('serverName')).toBe('panel');
  });

  it('keeps a saved value across a restart, and clearing goes back to the environment', async () => {
    let c = await load({ HEARTH_NAME: 'Home' });
    c.updateConfig({ serverName: 'Saved' });
    c = await load({ HEARTH_NAME: 'Home' });
    expect(c.cfg('serverName')).toBe('Saved');
    expect(process.env.HEARTH_NAME).toBe('Saved');
    c.updateConfig({ serverName: null });
    expect(c.cfg('serverName')).toBe('Home');
    expect(c.sourceOf('serverName')).toBe('environment');
    expect(process.env.HEARTH_NAME).toBe('Home');
  });

  it('writes the file readable only by its owner and contains no environment values', async () => {
    const c = await load({ HEARTH_NAME: 'Home' });
    c.updateConfig({ registration: 'open' });
    const file = path.join(dir, 'config.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ registration: 'open' });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it('refuses a bad value and saves nothing', async () => {
    const c = await load();
    expect(() => c.updateConfig({ registration: 'maybe' })).toThrow(/one of/);
    expect(() => c.updateConfig({ backupQuotaMb: '12.5' })).toThrow(/whole number/);
    expect(() => c.updateConfig({ backupQuotaMb: '0' })).toThrow(/at least/);
    expect(() => c.updateConfig({ registrationKey: 'short' })).toThrow(/8 or more/);
    expect(() => c.updateConfig({ livekitUrl: 'nope' })).toThrow(/wss/);
    expect(() => c.updateConfig({ nothing: 'x' })).toThrow(/unknown/);
    expect(() => c.updateConfig({ serverName: 'fine', registration: 'maybe' })).toThrow();
    expect(c.cfg('serverName')).toBe('Hearth');
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false);
  });

  it('says which changes need a restart', async () => {
    const c = await load();
    expect(c.updateConfig({ serverName: 'A' })).toEqual({ changed: ['serverName'], restart: false });
    expect(c.updateConfig({ livekitKey: 'k' })).toEqual({ changed: ['livekitKey'], restart: true });
    expect(c.updateConfig({ serverName: 'A' })).toEqual({ changed: [], restart: false });
  });

  it('keeps live settings in process.env so code that reads it sees a change at once', async () => {
    const c = await load();
    c.updateConfig({ backupQuotaMb: '10', browser: 'off' });
    expect(process.env.BACKUP_QUOTA_MB).toBe('10');
    expect(c.browserEnabled()).toBe(false);
    expect(c.cfgNumber('backupQuotaMb')).toBe(10);
  });

  it('never shows a secret, only whether one is set', async () => {
    const c = await load({ LIVEKIT_API_SECRET: 'x'.repeat(40) });
    const view = c.describeConfig().find((s) => s.key === 'livekitSecret')!;
    expect(view.value).toBeNull();
    expect(view.set).toBe(true);
    expect(JSON.stringify(c.describeConfig())).not.toContain('xxxxxxxx');
  });

  it('treats the old REGISTRATION=1 and true spellings as open', async () => {
    for (const v of ['1', 'true', 'on', 'open']) expect((await load({ REGISTRATION: v })).registrationOpen()).toBe(true);
    expect((await load()).registrationOpen()).toBe(false);
    expect((await load({ REGISTRATION: 'invite' })).registrationOpen()).toBe(false);
  });
});
