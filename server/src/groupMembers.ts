import { db, isMember, memberIds, now } from './db.js';
import { canSee } from './contacts.js';
import { blockedEitherWay } from './social.js';

/**
 * Who is in a group chat. Anyone in a group may add people they know (their contacts, or people they already share a chat with, and nobody
 * who blocked them or whom they blocked). Only the person who made the group may remove someone else; anyone can always leave. When the
 * person who made the group leaves, the group passes to whoever has been in it longest, so there is always someone who can remove people.
 *
 * Encrypted chats need nothing extra here: their keys come from the community key every signed-in device already holds, so a person who is
 * added can read the chat at once. That includes the earlier messages, which the client says before adding.
 */

export class MemberError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const MAX_MEMBERS = 256;
export const MAX_PER_CALL = 50;

interface RoomRow {
  id: string;
  kind: string;
  created_by: string | null;
}

function groupOf(roomId: string): RoomRow {
  const room = db.prepare('SELECT id, kind, created_by FROM rooms WHERE id = ?').get(roomId) as RoomRow | undefined;
  if (!room) throw new MemberError(404, 'no such chat');
  if (room.kind !== 'group') throw new MemberError(400, 'people can only be added to or removed from group chats');
  return room;
}

export interface AddResult {
  added: string[];
  skipped: Array<{ id: string; reason: string }>;
}

export function addMembers(roomId: string, actor: string, userIds: unknown): AddResult {
  const room = groupOf(roomId);
  if (!isMember(room.id, actor)) throw new MemberError(403, 'not a member');
  if (!Array.isArray(userIds) || userIds.length === 0 || userIds.some((u) => typeof u !== 'string')) throw new MemberError(400, 'say who to add');
  const wanted = [...new Set(userIds as string[])];
  if (wanted.length > MAX_PER_CALL) throw new MemberError(400, `add at most ${MAX_PER_CALL} people at a time`);

  const added: string[] = [];
  const skipped: AddResult['skipped'] = [];
  const insert = db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)');
  let size = memberIds(room.id).length;
  for (const id of wanted) {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) { skipped.push({ id, reason: 'no such person' }); continue; }
    if (isMember(room.id, id)) { skipped.push({ id, reason: 'already in the group' }); continue; }
    if (blockedEitherWay(actor, id)) { skipped.push({ id, reason: 'cannot be added' }); continue; }
    if (!canSee(actor, id)) { skipped.push({ id, reason: 'not one of your contacts' }); continue; }
    if (size >= MAX_MEMBERS) { skipped.push({ id, reason: 'the group is full' }); continue; }
    // Joining now: everything said before is already "read", so a new member does not open to a hundred unread messages.
    insert.run(room.id, id, now(), now());
    added.push(id);
    size++;
  }
  return { added, skipped };
}

export function removeMember(roomId: string, actor: string, target: string): void {
  const room = groupOf(roomId);
  if (!isMember(room.id, actor)) throw new MemberError(403, 'not a member');
  if (target === actor) throw new MemberError(400, 'to go yourself, leave the group');
  if (!isMember(room.id, target)) throw new MemberError(404, 'that person is not in the group');
  // A group from before this feature has no recorded maker: any member may remove then.
  if (room.created_by && room.created_by !== actor) throw new MemberError(403, 'only the person who made the group can remove people');
  db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(room.id, target);
}

/** The maker of a group is leaving: hand it to the member who has been in it longest. */
export function passOnGroup(roomId: string, leaving: string): void {
  const room = db.prepare('SELECT created_by FROM rooms WHERE id = ?').get(roomId) as { created_by: string | null } | undefined;
  if (!room || room.created_by !== leaving) return;
  const next = db
    .prepare('SELECT user_id FROM room_members WHERE room_id = ? AND user_id != ? ORDER BY joined_at ASC, rowid ASC LIMIT 1')
    .get(roomId, leaving) as { user_id: string } | undefined;
  if (next) db.prepare('UPDATE rooms SET created_by = ? WHERE id = ?').run(next.user_id, roomId);
}
