import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupLimits, listBackups, usedBytes, validBackupName } from './serverBackups.js';

describe('backups kept on the server', () => {
  it('only accepts plain file names', () => {
    expect(validBackupName('ember-backup-20261030-025304.embkup')).toBe(true);
    expect(validBackupName('archive.zip')).toBe(true);
    for (const bad of ['', '.hidden', '../x', 'a/b', 'a\\b', 'x'.repeat(200), 'name with space', undefined, 7]) expect(validBackupName(bad)).toBe(false);
  });

  it('lists the newest first and does not show half-written files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
    fs.writeFileSync(path.join(dir, 'a.embkup'), 'aaaa');
    fs.writeFileSync(path.join(dir, 'b.embkup'), 'bb');
    fs.writeFileSync(path.join(dir, 'c.embkup.123.part'), 'partial');
    const now = Date.now();
    fs.utimesSync(path.join(dir, 'a.embkup'), new Date(now - 60_000), new Date(now - 60_000));
    fs.utimesSync(path.join(dir, 'b.embkup'), new Date(now), new Date(now));
    expect(listBackups(dir).map((f) => f.name)).toEqual(['b.embkup', 'a.embkup']);
    expect(usedBytes(dir)).toBe(6);
    expect(listBackups(path.join(dir, 'nobody'))).toEqual([]);
  });

  it('reads its limits from the environment', () => {
    expect(backupLimits({})).toEqual({ maxFile: 1024 * 1024 * 1024, quota: 4096 * 1024 * 1024 });
    expect(backupLimits({ BACKUP_MAX_FILE_MB: '10', BACKUP_QUOTA_MB: '20' })).toEqual({ maxFile: 10 * 1024 * 1024, quota: 20 * 1024 * 1024 });
  });
});
