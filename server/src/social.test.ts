import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const fs = await import('node:fs');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const source = fs.readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
  db.exec(source.match(/db\.exec\(`([\s\S]*?)`\);/)![1]!);
  return { db, now: () => Date.now(), publicUser: (u: unknown) => u };
});
vi.mock('./nativeQueue.js', () => ({ revokeNativeSession: () => {}, purgeNativeNotifications: () => {} }));

import { db } from './db.js';
import { hashPassword } from './auth.js';
import { requestContact, areContacts, pendingFor } from './contacts.js';
import {
  blockUser, blockedEitherWay, blockedIds, dmBlocked, findUser, friendCodeOf, newFriendCode, normalizeCode, passwordUsedBefore, setNewPassword,
  showCode, unblockUser, isArchived, setArchived, usernameFree, validUsername,
} from './social.js';
import type { UserRow } from './db.js';

const addUser = (id: string, password = 'first-password') =>
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, 1)").run(id, id, id, hashPassword(password));
const row = (id: string) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;

beforeEach(() => {
  db.exec('DELETE FROM blocks; DELETE FROM password_history; DELETE FROM sessions; DELETE FROM contacts; DELETE FROM room_members; DELETE FROM rooms; DELETE FROM users;');
  for (const u of ['ann', 'bob', 'cat']) addUser(u);
});

describe('friend codes', () => {
  it('are six characters without look-alikes, and unique', () => {
    const codes = new Set(Array.from({ length: 200 }, () => newFriendCode()));
    for (const c of codes) expect(c).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(friendCodeOf('ann')).toBe(friendCodeOf('ann'));
    expect(friendCodeOf('ann')).not.toBe(friendCodeOf('bob'));
  });

  it('read the same however they are typed', () => {
    expect(normalizeCode('abc-234')).toBe('ABC234');
    expect(normalizeCode(' abc 234 ')).toBe('ABC234');
    expect(normalizeCode('ABC23')).toBeNull();
    expect(normalizeCode('ABCO23')).toBeNull();
    expect(showCode('ABC234')).toBe('ABC-234');
  });

  it('find a person by code or by name in one box', () => {
    const code = friendCodeOf('bob');
    expect(findUser(code)?.id).toBe('bob');
    expect(findUser(code.toLowerCase(), 'code')?.id).toBe('bob');
    expect(findUser('@BOB')?.id).toBe('bob');
    expect(findUser('bob', 'code')).toBeUndefined();
    expect(findUser('nobody')).toBeUndefined();
  });
});

describe('usernames', () => {
  it('must be 3 to 24 safe characters', () => {
    expect(validUsername('ann.lee_9')).toBe(true);
    expect(validUsername('ab')).toBe(false);
    expect(validUsername('has space')).toBe(false);
    expect(validUsername('x'.repeat(25))).toBe(false);
  });

  it('cannot be taken by two people, ignoring case, but a freed name can be used again', () => {
    expect(usernameFree('BOB')).toBe(false);
    expect(usernameFree('bob', 'bob')).toBe(true);
    db.prepare("UPDATE users SET username = 'bobby' WHERE id = 'bob'").run();
    expect(usernameFree('bob')).toBe(true);
    db.prepare("UPDATE users SET username = 'bob' WHERE id = 'cat'").run();
    expect(row('cat').username).toBe('bob');
  });
});

describe('passwords', () => {
  it('cannot come back once changed', () => {
    expect(passwordUsedBefore(row('ann'), 'first-password')).toBe(true);
    setNewPassword(row('ann'), 'second-password', null);
    expect(passwordUsedBefore(row('ann'), 'second-password')).toBe(true);
    expect(passwordUsedBefore(row('ann'), 'first-password')).toBe(true);
    setNewPassword(row('ann'), 'third-password', null);
    expect(passwordUsedBefore(row('ann'), 'first-password')).toBe(true);
    expect(passwordUsedBefore(row('ann'), 'brand-new-one')).toBe(false);
  });

  it('signs out every other session and keeps the one making the change', () => {
    const add = db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, 1, ?)');
    add.run('keep', 'ann', Date.now() + 1e6);
    add.run('drop', 'ann', Date.now() + 1e6);
    add.run('other', 'bob', Date.now() + 1e6);
    setNewPassword(row('ann'), 'second-password', 'keep');
    const left = (db.prepare('SELECT token FROM sessions').all() as { token: string }[]).map((r) => r.token).sort();
    expect(left).toEqual(['keep', 'other']);
  });
});

describe('blocking', () => {
  it('ends a friendship and a pending request, both ways round', () => {
    requestContact('ann', 'bob');
    requestContact('bob', 'ann');
    expect(areContacts('ann', 'bob')).toBe(true);
    blockUser('ann', 'bob');
    expect(areContacts('ann', 'bob')).toBe(false);
    expect(blockedEitherWay('bob', 'ann')).toBe(true);
    expect(blockedIds('ann')).toEqual(['bob']);
    expect(blockedIds('bob')).toEqual([]);
    requestContact('cat', 'ann');
    blockUser('ann', 'cat');
    expect(pendingFor('ann').incoming).toEqual([]);
  });

  it('can be undone, and can not block yourself', () => {
    expect(blockUser('ann', 'ann')).toBe(false);
    blockUser('ann', 'bob');
    expect(unblockUser('ann', 'bob')).toBe(true);
    expect(blockedEitherWay('ann', 'bob')).toBe(false);
    expect(unblockUser('ann', 'bob')).toBe(false);
  });

  it('stops messages in a two-person chat only', () => {
    db.prepare("INSERT INTO rooms (id, kind, name, created_by, created_at) VALUES ('dm', 'dm', '', 'ann', 1)").run();
    db.prepare("INSERT INTO rooms (id, kind, name, created_by, created_at) VALUES ('grp', 'group', 'g', 'ann', 1)").run();
    for (const [r, u] of [['dm', 'ann'], ['dm', 'bob'], ['grp', 'ann'], ['grp', 'bob'], ['grp', 'cat']]) db.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, 1)').run(r, u);
    expect(dmBlocked('dm', 'bob')).toBe(false);
    blockUser('ann', 'bob');
    expect(dmBlocked('dm', 'bob')).toBe(true);
    expect(dmBlocked('dm', 'ann')).toBe(true);
    expect(dmBlocked('grp', 'bob')).toBe(false);
  });
});

describe('archiving', () => {
  it('is per person and starts off', () => {
    db.prepare("INSERT INTO rooms (id, kind, name, created_by, created_at) VALUES ('r', 'dm', '', 'ann', 1)").run();
    for (const u of ['ann', 'bob']) db.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, 1)').run('r', u);
    expect(isArchived('r', 'ann')).toBe(false);
    expect(setArchived('r', 'ann', true)).toBe(true);
    expect(isArchived('r', 'ann')).toBe(true);
    expect(isArchived('r', 'bob')).toBe(false);
    setArchived('r', 'ann', false);
    expect(isArchived('r', 'ann')).toBe(false);
  });

  it('does nothing for someone who is not in the room', () => {
    db.prepare("INSERT INTO rooms (id, kind, name, created_by, created_at) VALUES ('r2', 'group', 'g', 'ann', 1)").run();
    expect(setArchived('r2', 'cat', true)).toBe(false);
    expect(isArchived('r2', 'cat')).toBe(false);
  });
});
