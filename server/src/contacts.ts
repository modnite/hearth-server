import { db, now } from './db.js';

/**
 * Who may see whom. Hearth is not a public directory: you see yourself, your accepted contacts and anyone you share a chat with,
 * and nobody else. The same rule decides the people list, presence, who can start a chat with whom and who is told about a change.
 */
export interface ContactRow {
  user_a: string;
  user_b: string;
  requested_by: string;
  status: 'pending' | 'accepted';
  created_at: number;
}

const ordered = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

export function contactRow(x: string, y: string): ContactRow | undefined {
  const [a, b] = ordered(x, y);
  return db.prepare('SELECT * FROM contacts WHERE user_a = ? AND user_b = ?').get(a, b) as ContactRow | undefined;
}

export function areContacts(x: string, y: string): boolean {
  return contactRow(x, y)?.status === 'accepted';
}

export function shareARoom(x: string, y: string): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 FROM room_members a JOIN room_members b ON b.room_id = a.room_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1')
      .get(x, y),
  );
}

export function canSee(viewer: string, subject: string): boolean {
  return viewer === subject || areContacts(viewer, subject) || shareARoom(viewer, subject);
}

/** Everyone `viewer` may see, themselves included. */
export function visibleUserIds(viewer: string): Set<string> {
  const ids = new Set<string>([viewer]);
  const contacts = db
    .prepare("SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS id FROM contacts WHERE status = 'accepted' AND (user_a = ? OR user_b = ?)")
    .all(viewer, viewer, viewer) as { id: string }[];
  for (const c of contacts) ids.add(c.id);
  const room = db
    .prepare('SELECT DISTINCT b.user_id AS id FROM room_members a JOIN room_members b ON b.room_id = a.room_id WHERE a.user_id = ?')
    .all(viewer) as { id: string }[];
  for (const r of room) ids.add(r.id);
  return ids;
}

/** The people who may see `subject` (the same relation seen from the other side). */
export function viewersOf(subject: string): Set<string> {
  return visibleUserIds(subject);
}

export type RequestResult = 'sent' | 'accepted' | 'already' | 'self';

/** Ask `from` -> `to` to be contacts. If `to` had already asked `from`, that is an accept. */
export function requestContact(from: string, to: string): RequestResult {
  if (from === to) return 'self';
  const existing = contactRow(from, to);
  const [a, b] = ordered(from, to);
  if (!existing) {
    db.prepare("INSERT INTO contacts (user_a, user_b, requested_by, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(a, b, from, now());
    return 'sent';
  }
  if (existing.status === 'accepted') return 'already';
  if (existing.requested_by === from) return 'already';
  db.prepare("UPDATE contacts SET status = 'accepted' WHERE user_a = ? AND user_b = ?").run(a, b);
  return 'accepted';
}

/** `me` accepts a request that `other` made. */
export function acceptContact(me: string, other: string): boolean {
  const row = contactRow(me, other);
  if (!row || row.status !== 'pending' || row.requested_by !== other) return false;
  db.prepare("UPDATE contacts SET status = 'accepted' WHERE user_a = ? AND user_b = ?").run(row.user_a, row.user_b);
  return true;
}

/** Decline a request, cancel your own, or remove a contact. */
export function removeContact(me: string, other: string): boolean {
  const [a, b] = ordered(me, other);
  return db.prepare('DELETE FROM contacts WHERE user_a = ? AND user_b = ?').run(a, b).changes > 0;
}

export function pendingFor(me: string): { incoming: string[]; outgoing: string[] } {
  const rows = db
    .prepare("SELECT * FROM contacts WHERE status = 'pending' AND (user_a = ? OR user_b = ?)")
    .all(me, me) as ContactRow[];
  const incoming: string[] = [];
  const outgoing: string[] = [];
  for (const r of rows) {
    const other = r.user_a === me ? r.user_b : r.user_a;
    (r.requested_by === me ? outgoing : incoming).push(other);
  }
  return { incoming, outgoing };
}

export function contactIds(me: string): string[] {
  const rows = db
    .prepare("SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS id FROM contacts WHERE status = 'accepted' AND (user_a = ? OR user_b = ?)")
    .all(me, me, me) as { id: string }[];
  return rows.map((r) => r.id);
}

/** A new person who joined by someone's invite is that person's contact from the start. */
export function connectViaInvite(inviter: string, joiner: string): void {
  const [a, b] = ordered(inviter, joiner);
  db.prepare("INSERT OR IGNORE INTO contacts (user_a, user_b, requested_by, status, created_at) VALUES (?, ?, ?, 'accepted', ?)").run(a, b, inviter, now());
}
