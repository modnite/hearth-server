import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const fs = await import('node:fs');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const source = fs.readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
  db.exec(source.match(/db\.exec\(`([\s\S]*?)`\);/)![1]!);
  const isMember = (room: string, user: string) => Boolean(db.prepare('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?').get(room, user));
  const memberIds = (room: string) => (db.prepare('SELECT user_id FROM room_members WHERE room_id=?').all(room) as { user_id: string }[]).map((r) => r.user_id);
  let clock = 1000;
  return { db, now: () => ++clock, isMember, memberIds, publicUser: (u: unknown) => u };
});
vi.mock('./nativeQueue.js', () => ({ revokeNativeSession: () => {}, purgeNativeNotifications: () => {} }));

import { db } from './db.js';
import { requestContact, acceptContact } from './contacts.js';
import { blockUser } from './social.js';
import { addMembers, MAX_MEMBERS, MemberError, passOnGroup, removeMember } from './groupMembers.js';

const user = (id: string) => db.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, 'x', 1)").run(id, id, id);
const friends = (a: string, b: string) => { requestContact(a, b); acceptContact(b, a); };
const group = (id: string, creator: string | null, members: string[], kind = 'group') => {
  db.prepare('INSERT INTO rooms (id, kind, name, created_by, created_at) VALUES (?, ?, ?, ?, 1)').run(id, kind, 'g', creator);
  members.forEach((m, i) => db.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, m, i + 1));
};
const members = (room: string) => (db.prepare('SELECT user_id FROM room_members WHERE room_id=? ORDER BY joined_at').all(room) as { user_id: string }[]).map((r) => r.user_id);
const fails = (fn: () => unknown, status: number) => { try { fn(); } catch (e) { expect(e).toBeInstanceOf(MemberError); expect((e as MemberError).status).toBe(status); return; } throw new Error('did not throw'); };

beforeEach(() => {
  db.exec('DELETE FROM blocks; DELETE FROM contacts; DELETE FROM room_members; DELETE FROM rooms; DELETE FROM users;');
  for (const u of ['ann', 'bob', 'cat', 'dan', 'eve']) user(u);
  friends('ann', 'bob'); friends('ann', 'cat'); friends('bob', 'dan');
  group('g1', 'ann', ['ann', 'bob']);
});

describe('adding people', () => {
  it('lets a member add their contacts, and says who it skipped and why', () => {
    const r = addMembers('g1', 'ann', ['cat', 'eve', 'ghost', 'bob']);
    expect(r.added).toEqual(['cat']);
    expect(r.skipped).toEqual([
      { id: 'eve', reason: 'not one of your contacts' },
      { id: 'ghost', reason: 'no such person' },
      { id: 'bob', reason: 'already in the group' },
    ]);
    expect(members('g1')).toEqual(['ann', 'bob', 'cat']);
  });

  it('lets any member add, not only the one who made the group', () => {
    expect(addMembers('g1', 'bob', ['dan']).added).toEqual(['dan']);
  });

  it('allows a person you share a chat with even if you are not contacts', () => {
    group('g2', 'ann', ['ann', 'dan']);
    expect(addMembers('g1', 'ann', ['dan']).added).toEqual(['dan']);
  });

  it('never adds across a block, in either direction', () => {
    blockUser('ann', 'cat');
    expect(addMembers('g1', 'ann', ['cat']).skipped).toEqual([{ id: 'cat', reason: 'cannot be added' }]);
    blockUser('dan', 'bob');
    expect(addMembers('g1', 'bob', ['dan']).added).toEqual([]);
  });

  it('marks everything said before as read for a new member', () => {
    db.prepare("INSERT INTO messages (id, room_id, user_id, body, created_at) VALUES ('m1', 'g1', 'ann', 'hi', 5)").run();
    addMembers('g1', 'ann', ['cat']);
    const row = db.prepare("SELECT last_read_at FROM room_members WHERE room_id='g1' AND user_id='cat'").get() as { last_read_at: number };
    expect(row.last_read_at).toBeGreaterThan(5);
  });

  it('refuses outsiders, direct chats, empty and oversized requests', () => {
    fails(() => addMembers('g1', 'cat', ['dan']), 403);
    group('d1', 'ann', ['ann', 'bob'], 'dm');
    fails(() => addMembers('d1', 'ann', ['cat']), 400);
    fails(() => addMembers('nope', 'ann', ['cat']), 404);
    fails(() => addMembers('g1', 'ann', []), 400);
    fails(() => addMembers('g1', 'ann', 'cat'), 400);
    fails(() => addMembers('g1', 'ann', Array.from({ length: 51 }, (_, i) => `u${i}`)), 400);
  });

  it('stops at the size limit', () => {
    group('big', 'ann', ['ann']);
    const stmt = db.prepare("INSERT INTO room_members (room_id, user_id, joined_at) VALUES ('big', ?, 1)");
    for (let i = 0; i < MAX_MEMBERS - 1; i++) { user(`x${i}`); stmt.run(`x${i}`); }
    expect(addMembers('big', 'ann', ['cat']).skipped).toEqual([{ id: 'cat', reason: 'the group is full' }]);
  });
});

describe('removing people', () => {
  it('lets the maker of the group remove someone', () => {
    removeMember('g1', 'ann', 'bob');
    expect(members('g1')).toEqual(['ann']);
  });

  it('does not let anyone else remove, nor the maker remove themselves', () => {
    addMembers('g1', 'ann', ['cat']);
    fails(() => removeMember('g1', 'bob', 'cat'), 403);
    fails(() => removeMember('g1', 'ann', 'ann'), 400);
    fails(() => removeMember('g1', 'ann', 'dan'), 404);
    fails(() => removeMember('g1', 'eve', 'bob'), 403);
    expect(members('g1')).toEqual(['ann', 'bob', 'cat']);
  });

  it('lets any member remove in an older group that has no recorded maker', () => {
    group('old', null, ['ann', 'bob', 'cat']);
    removeMember('old', 'bob', 'cat');
    expect(members('old')).toEqual(['ann', 'bob']);
  });

  it('hands the group on when its maker leaves', () => {
    addMembers('g1', 'ann', ['cat']);
    db.prepare("DELETE FROM room_members WHERE room_id='g1' AND user_id='ann'").run();
    passOnGroup('g1', 'ann');
    expect((db.prepare("SELECT created_by FROM rooms WHERE id='g1'").get() as { created_by: string }).created_by).toBe('bob');
    removeMember('g1', 'bob', 'cat');
    expect(members('g1')).toEqual(['bob']);
  });

  it('leaves the maker alone when somebody else leaves', () => {
    passOnGroup('g1', 'bob');
    expect((db.prepare("SELECT created_by FROM rooms WHERE id='g1'").get() as { created_by: string }).created_by).toBe('ann');
  });
});
