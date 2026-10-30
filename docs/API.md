# Building a client for the Hearth server

Hearth is a server. Ember (Android) and the Hearth web app are two clients of it. Everything a client does goes through the HTTP API and one WebSocket described here, so you can write another: a desktop app, a terminal client, a bot, a bridge.

This guide covers what a client needs to know. The server's exact route list is always at `GET /api/admin/routes` (administrators, or the **For client builders** tab of the admin panel), and the source in `server/src/routes.ts` is the reference for request and response shapes.

## 1. Find out what you are talking to

`GET /api/server/info` needs no sign-in:

```json
{
  "software": "hearth-server",
  "version": "1.0.1",
  "apiVersion": 1,
  "name": "Hearth",
  "motd": "",
  "registration": "invite",
  "houseKey": false,
  "setupNeeded": false,
  "features": { "calls": true, "push": false, "backups": true, "browser": true, "twoStep": true, "friends": true },
  "limits": { "backupQuotaMb": 4096, "backupMaxFileMb": 1024 }
}
```

- Check `software` and `apiVersion`. `apiVersion` only goes up when something a client depends on changes in a way it must notice. Additive changes (new routes, new fields) do not bump it, so ignore fields you do not know.
- Use `features` to hide what the server cannot do (no calls without LiveKit, no backups if the owner switched them off).
- `registration` is `open` or `invite`. `houseKey` says whether a shared passphrase works in place of an invite code.
- `setupNeeded` is true on a brand-new server: the operator has to open `/admin` first.

Serve your own client from anywhere. The API sends no CORS headers: a browser client must be served from the same origin (put it behind the same reverse proxy) or you add a proxy rule. Native clients are not affected.

## 2. Sign in

Sessions are an opaque cookie named `hearth_session`. Native clients keep it themselves and send it back as a `Cookie` header.

| Call | Body | Result |
|---|---|---|
| `POST /api/auth/register` | `{ "invite": "code or house key", "username", "displayName"?, "password" }` (password 8+ characters) | `{ "user": {...} }` and a session cookie. With `registration: "open"` the code may be left out. |
| `POST /api/auth/login` | `{ "username", "password", "code"? }` | `{ "user": {...} }` and a session cookie. `401` with `needs2fa: true` means ask for the authenticator code and send it as `code`. `403` means the administrator switched the account off. `429` has `retry-after`. |
| `GET /api/auth/me` | | `{ "user": {...}, "admin": false }` |
| `POST /api/auth/logout` | | ends the session |
| `POST /api/auth/remember` / `remember-login` / `forget` | | "remember this device" tokens for clients that do not want to keep the cookie |
| `POST /api/auth/change-password`, `/api/auth/username` | | rename and password change (no reuse of an old password) |
| `GET/POST /api/auth/2fa/...` | | authenticator-app two-step sign-in |

The user object:

```json
{ "id": "…", "username": "ann", "displayName": "Ann", "avatarColor": "#7c6cff", "avatar": "/api/avatars/…" , "wallpaper": null, "status": "online", "statusMessage": "" }
```

An account is addressed by `id` everywhere. Usernames can change.

## 3. People, friends, blocks

`GET /api/users/lookup?q=…` finds a person by exact username or friend code. `GET /api/contacts` lists contacts and pending requests; `POST /api/contacts` sends a request; `POST /api/contacts/:id/accept`; `DELETE /api/contacts/:id` removes or rejects. `GET/POST /api/friend-code` shows or rotates your friend code. `GET/POST /api/blocks`, `DELETE /api/blocks/:id`. People can only see and message people they are connected to.

## 4. Chats, messages, files

- `GET /api/rooms` lists your chats (direct messages and groups) with unread counts and `archived`.
- `POST /api/rooms` `{ "name", "topic"?, "memberIds": [], "encrypted"? }` makes a group. `POST /api/users/:id/dm` opens or returns a direct chat.
- Group management:
  - `PATCH /api/rooms/:id` `{ "name"?, "topic"? }` renames a group. Any member can. Direct chats cannot be renamed.
  - `POST /api/rooms/:id/members` `{ "userIds": [] }` adds people. Any member can add their own contacts. The answer lists `added` and `skipped`.
  - `DELETE /api/rooms/:id/members/:userId` removes someone. Only the person who made the group can.
  - `POST /api/rooms/:id/leave` leaves. If the maker leaves, the group passes to whoever has been in it longest. An empty group is deleted.
  - `POST` and `DELETE /api/rooms/:id/avatar` set and remove the group picture.
  - Each change sends `room.updated` to members, `room.removed` to the person removed, and a `room.event` line with a plain-text description.
- `GET /api/rooms/:id/messages?before=<ms>&limit=<n ≤ 200>` returns `{ "messages": [...] }`, oldest first. Page back with `before` set to the oldest `createdAt` you have.
- `POST /api/rooms/:id/messages` `{ "body", "replyTo"? }` (up to 16000 characters) returns `{ "message": {...} }`.
- `PATCH` and `DELETE /api/messages/:id`, `POST /api/messages/:id/reactions`, `/pin`, `/forward`.
- `POST /api/rooms/:id/read` marks read. `POST /api/rooms/:id/archive` `{ "archived": true }` archives for you only (no notifications, unread count kept).
- `POST /api/rooms/:id/attachments` is a `multipart/form-data` upload (one file, up to 200 MB) that creates a message with the file; `GET /api/attachments/:id` downloads and supports `Range`.
- `GET /api/search?q=…` searches the messages you can see.

Chats can be end-to-end encrypted (`encrypted: true`). The server then only stores ciphertext and the public device keys and key wraps (`/api/e2ee/*`); the cryptography is entirely the client's job.

## 5. The real-time channel

`GET /ws` upgrades to a WebSocket. Send the session cookie in the upgrade request. Add `?device=<id>` (up to 64 characters) to name this device; it keeps several devices of one person apart in calls.

Frames are JSON objects with a type in `t`.

**You send**

| Frame | Meaning |
|---|---|
| `{ "t": "subscribe", "roomId" }` | get live events for a chat (the server replies `subscribed`) |
| `{ "t": "typing", "roomId", "typing": true }` | typing indicator |
| `{ "t": "nudge", "roomId" }` | a nudge (rate limited) |
| `{ "t": "presence.set", "status": "online\|away\|busy\|invisible", "statusMessage" }` | your status |
| `{ "t": "presence.visibility", "visible": false }` | whether this device is on screen (the server only sends push notifications when no device is) |
| `call.start`, `call.join`, `call.leave`, `call.accept`, `call.decline`, `call.end` with `roomId`, and `call.state` | call signalling (section 6) |

**You receive** (the ones listed here; ignore types you do not know)

`message`, `message.updated`, `message.deleted`, `pins`, `read`, `typing`, `nudge`, `presence`, `room.updated`, `room.removed`, `room.event`, `contacts.changed`, `call.ring.stop`, `call.accepted`, `call.declined`, `call.end`, and call state frames.

The server pings; reply to pings (any WebSocket library does) or it drops you. After a drop, reconnect with back-off and re-fetch what you missed with `GET /api/rooms/:id/messages`. A person counts as offline about 20 seconds after their last socket closes.

## 6. Calls

Calls use LiveKit. `features.calls` says whether the server has it.

1. Signal over the WebSocket: `call.start` rings the other members; `call.join`, `call.accept`, `call.decline`, `call.leave`, `call.end`.
2. Get media access with `POST /api/rooms/:id/call/token` `{ "device"? }`. The answer is `{ "url", "token", "room" }`: connect any LiveKit client SDK to `url` with `token`.
3. Report your mic and camera state with `call.state` so others see it.

## 7. Notifications for apps that are not running

- **Web push:** `GET /api/push/key`, then `POST /api/push/subscribe` and `/unsubscribe`. Needs VAPID keys on the server (`features.push`).
- **Native long-poll (no Google services):** `POST /api/native/notifications/register`, then `GET /api/native/notifications/events` as a long poll, and `POST …/ack`. This is how Ember delivers calls and messages without FCM.

## 8. Backups kept on the server

If `features.backups` is true, a client may store sealed backup files for the signed-in person. The server cannot read them; the client encrypts first.

| Call | |
|---|---|
| `GET /api/backup/files` | `{ "files": [{ "name", "size", "modifiedAt" }], "quota": { "used", "limit", "maxFile" } }` |
| `PUT /api/backup/files/:name` | the file as the raw body, `Content-Type: application/octet-stream`. `413` too large, `507` out of space. Names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$`. |
| `GET /api/backup/files/:name` | download |
| `DELETE /api/backup/files/:name` | delete |
| `GET /api/backup/key` | the person's backup key (so a new device can open their backups after signing in) |

A good client offers this next to other places (a folder, WebDAV, S3, FTP, SFTP) and, on a fresh install, offers to restore from it right after the first sign-in. Ember does exactly that.

## 9. Errors

Errors are JSON, `{ "error": "plain words a person can read" }`, with a fitting status: `400` bad input, `401` not signed in, `403` not allowed, `404`, `409` conflict, `413`, `429` slow down (`retry-after` in seconds), `507` out of space. Show the message as it is.

## 10. Administrators

`/api/admin/*` is the administrator API behind the admin panel (`GET /admin`). It needs a session of an account with `admin: true` and refuses requests whose `Origin` is another site. A client does not need it, but a management tool can use it.

## 11. Be a good citizen

- Send your own `User-Agent`.
- Keep one WebSocket per device, not one per chat.
- Back off when you get `429` or `5xx`.
- Do not store the password. Keep the session cookie in the platform's secure storage.
