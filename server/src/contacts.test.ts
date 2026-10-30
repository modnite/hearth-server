import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const fs = await import('node:fs');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Exercise the production schema, not a second test-only copy of it.
  const source = fs.readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
  db.exec(source.match(/db\.exec\(`([\s\S]*?)`\);/)![1]!);
  return { db, now: () => Date.now() };
});

import { db } from './db.js';
import {
  acceptContact, areContacts, canSee, connectViaInvite, contactIds, pendingFor, removeContact, requestContact, viewersOf, visibleUserIds,
} from './contacts.js';

const addUser = (id: string) =>
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, 'x', 1)").run(id, id, id);
const room = (id: string, ...members: string[]) => {
  db.prepare("INSERT INTO rooms (id, kind, name, created_by, created_at) VALUES (?, 'group', ?, ?, 1)").run(id, id, members[0]);
  for (const m of members) db.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, 1)').run(id, m);
};

beforeEach(() => {
  db.exec('DELETE FROM contacts; DELETE FROM room_members; DELETE FROM rooms; DELETE FROM users;');
  for (const u of ['ann', 'bob', 'cat', 'dan']) addUser(u);
});

describe('who can see whom', () => {
  it('shows nobody to anybody by default', () => {
    expect([...visibleUserIds('ann')]).toEqual(['ann']);
    expect(canSee('ann', 'bob')).toBe(false);
    expect([...viewersOf('bob')]).toEqual(['bob']);
  });

  it('needs the other person to accept a request', () => {
    expect(requestContact('ann', 'bob')).toBe('sent');
    expect(canSee('ann', 'bob')).toBe(false);
    expect(pendingFor('bob')).toEqual({ incoming: ['ann'], outgoing: [] });
    expect(pendingFor('ann')).toEqual({ incoming: [], outgoing: ['bob'] });
    expect(acceptContact('ann', 'bob')).toBe(false); // the asker cannot accept their own request
    expect(acceptContact('bob', 'ann')).toBe(true);
    expect(areContacts('ann', 'bob')).toBe(true);
    expect(canSee('bob', 'ann')).toBe(true);
    expect(contactIds('ann')).toEqual(['bob']);
  });

  it('treats a request in return as acceptance', () => {
    requestContact('ann', 'bob');
    expect(requestContact('bob', 'ann')).toBe('accepted');
    expect(areContacts('ann', 'bob')).toBe(true);
    expect(requestContact('ann', 'ann')).toBe('self');
  });

  it('lets people in a chat together see each other, but not each other\'s other contacts', () => {
    room('r1', 'ann', 'bob', 'cat');
    expect(canSee('ann', 'cat')).toBe(true);
    expect(canSee('ann', 'dan')).toBe(false);
    connectViaInvite('ann', 'dan');
    expect([...visibleUserIds('dan')].sort()).toEqual(['ann', 'dan']);
    expect([...viewersOf('ann')].sort()).toEqual(['ann', 'bob', 'cat', 'dan']);
  });

  it('declining, cancelling and removing all go through the same call and leave shared chats alone', () => {
    requestContact('ann', 'bob');
    expect(removeContact('bob', 'ann')).toBe(true);
    expect(pendingFor('bob').incoming).toEqual([]);
    connectViaInvite('ann', 'bob');
    room('r2', 'ann', 'bob');
    removeContact('ann', 'bob');
    expect(areContacts('ann', 'bob')).toBe(false);
    expect(canSee('ann', 'bob')).toBe(true); // still in a chat together
  });
});
