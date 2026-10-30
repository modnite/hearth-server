import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(':memory:');
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT)");
  let clock = 1_000_000_000_000;
  return { db, now: () => (clock += 1000) };
});

import { db } from './db.js';
import { deleteGroup, groupDetail, listGroups, openGroupCount, parseReport, pruneReports, setResolved, signatureOf, storeReport, LIMITS } from './crashReports.js';

const input = (over: Record<string, unknown> = {}) => {
  const parsed = parseReport({ source: 'ember', message: 'java.lang.IllegalStateException: no room 42', stack: 'java.lang.IllegalStateException: no room 42\n\tat org.hearth.ember.Chat.send(Chat.kt:10)\n\tat org.hearth.ember.Ui.tap(Ui.kt:99)', appVersion: '1.0.0', ...over });
  if (typeof parsed === 'string') throw new Error(parsed);
  return parsed;
};

beforeEach(() => {
  db.exec('DELETE FROM crash_reports; DELETE FROM crash_state; DELETE FROM users');
});

describe('parsing a report', () => {
  it('needs a source and a message', () => {
    expect(parseReport(null)).toMatch(/JSON/);
    expect(parseReport({ message: 'x' })).toMatch(/source/);
    expect(parseReport({ source: 'Ember App!', message: 'x' })).toMatch(/source/);
    expect(parseReport({ source: 'ember', message: '   ' })).toMatch(/message/);
  });
  it('cuts long text and drops an oversized context', () => {
    const r = input({ message: 'm'.repeat(5000), stack: 's'.repeat(50_000), context: { big: 'x'.repeat(LIMITS.context + 1) }, kind: 'weird' });
    expect(r.message).toHaveLength(LIMITS.message);
    expect(r.stack).toHaveLength(LIMITS.stack);
    expect(r.context).toBe('');
    expect(r.kind).toBe('crash');
  });
  it('keeps a small context', () => {
    expect(input({ context: { screen: 'chat' } }).context).toBe('{"screen":"chat"}');
  });
});

describe('signatures', () => {
  it('ignore line numbers, numbers in the message and the order of unrelated fields', () => {
    const a = signatureOf('ember', 'Boom 12', 'X\n\tat a.B.c(B.kt:1)\n\tat a.D.e(D.kt:2)');
    const b = signatureOf('ember', 'Boom 99', 'X\n\tat a.B.c(B.kt:77)\n\tat a.D.e(D.kt:80)');
    expect(a).toBe(b);
  });
  it('tell different crashes and different sources apart', () => {
    const a = signatureOf('ember', 'Boom', 'X\n\tat a.B.c(B.kt:1)');
    expect(signatureOf('ember', 'Boom', 'X\n\tat a.Z.c(Z.kt:1)')).not.toBe(a);
    expect(signatureOf('web', 'Boom', 'X\n\tat a.B.c(B.kt:1)')).not.toBe(a);
  });
  it('read browser stacks too', () => {
    expect(signatureOf('web', 'TypeError: x', 'render@https://h/assets/index-a1.js:1:2345\nrun@https://h/assets/index-a1.js:1:99'))
      .toBe(signatureOf('web', 'TypeError: x', 'render@https://h/assets/index-b2.js:7:11\nrun@https://h/assets/index-b2.js:7:300'));
  });
});

describe('groups', () => {
  it('count occurrences, people and versions', () => {
    db.prepare("INSERT INTO users (id, username) VALUES ('u1','ann'), ('u2','bo')").run();
    storeReport(input(), 'u1');
    storeReport(input({ appVersion: '1.0.1' }), 'u2');
    storeReport(input({ appVersion: '1.0.1' }), 'u2');
    storeReport(input({ message: 'other', stack: 'other\n\tat z.Y.x(Y.kt:1)' }), null);
    const groups = listGroups();
    expect(groups).toHaveLength(2);
    const g = groups.find((x) => x.count === 3)!;
    expect(g.people).toBe(2);
    expect(g.versions).toEqual(['1.0.1', '1.0.0']);
    expect(g.title).toContain('IllegalStateException');
    expect(openGroupCount()).toBe(2);
  });

  it('show the newest occurrences with who and the context', () => {
    db.prepare("INSERT INTO users (id, username) VALUES ('u1','ann')").run();
    const { signature } = storeReport(input({ context: { screen: 'chat' } }), 'u1');
    const d = groupDetail(signature)!;
    expect(d.reports[0]).toMatchObject({ user: 'ann', context: { screen: 'chat' }, appVersion: '1.0.0' });
    expect(groupDetail('nope')).toBeNull();
  });

  it('can be marked fixed, and a new crash reopens a fixed group', () => {
    const { signature } = storeReport(input(), null);
    expect(setResolved(signature, true, 'fixed in 1.0.2')).toBe(true);
    expect(listGroups({ status: 'open' })).toHaveLength(0);
    expect(listGroups({ status: 'resolved' })[0]!.note).toBe('fixed in 1.0.2');
    expect(openGroupCount()).toBe(0);
    storeReport(input(), null);
    expect(listGroups({ status: 'open' })).toHaveLength(1);
    expect(setResolved('missing', true)).toBe(false);
  });

  it('can be filtered by source and deleted', () => {
    storeReport(input(), null);
    const w = storeReport(input({ source: 'web', message: 'TypeError: q', stack: '' }), null);
    expect(listGroups({ source: 'web' })).toHaveLength(1);
    expect(deleteGroup(w.signature)).toBe(1);
    expect(listGroups()).toHaveLength(1);
  });
});

describe('pruning', () => {
  it('drops old reports and keeps at most the newest N', () => {
    for (const n of ['alpha', 'bravo', 'carol', 'delta', 'echo']) storeReport(input({ message: n, stack: `${n}\n\tat q.${n}.s(R.kt:1)` }), null);
    expect(pruneReports(3650, 3)).toBe(2);
    expect(listGroups()).toHaveLength(3);
    expect(pruneReports(0, 100)).toBe(3);
    expect(listGroups()).toHaveLength(0);
  });
});
