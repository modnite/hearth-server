# Changelog

## 1.2.0 (1 Nov 2026)
- Mirrors: any number of other servers keep a live copy (database and files) and take over by themselves when the main server stops answering, then hand back by themselves when it returns. The Mirrors page links a mirror with a one-time code. A mirror can be made the main server for good. See docs/MIRRORS.md.
- `GET /api/server/info` carries `cluster` (round, whether this server is serving, the addresses of the group) so apps can move between servers; `POST /api/auth/portable` and `POST /api/auth/adopt` carry a sign-in to another server of the group.
- Calls use one UDP port (7882) by default, so a router needs one forward instead of a range.
- Opt-in UPnP: `docker compose --profile upnp up -d` opens the call ports on a router that offers it.

## 1.1.1 (30 Oct 2026)
- Admin panel: a secret that is not set shows "Not set" and a Set button, a secret that is set shows "Set" with Replace and Clear, a pending clear shows "Will be cleared" with Undo. Editing always ends with Cancel. Before, an unset secret was a bare text box.

## 1.1.0 (30 Oct 2026)
- Crash reports: `POST /api/crash-reports` (any client, signed in or not, 30 per hour per address), a Crashes page in the admin panel, grouping by signature, mark fixed, notes, copy, delete, automatic pruning, settings `CRASH_REPORTS` and `CRASH_KEEP_DAYS`.
- `features.crashReports` in `GET /api/server/info`.
- Panel: phone cards left-align their first cell.

## 1.0.1 (30 Oct 2026)
- Admin panel: even grids on desktop, tables become cards on phones, nothing cut off, a dismiss button on the setup list, a long welcome note wraps.
- The image published to ghcr carries this panel.

## 1.0.0 (30 Oct 2026)
- Standalone server with an admin panel, a configuration layer (panel, then environment, then default) and API documentation.
- Group chats: add and remove people, rename, hand over when the maker leaves.
- One-file stack: `init`, `hearth`, `livekit` and optional `caddy`. The server makes its own session secret.
- LiveKit pinned to v1.13.11.
- Image published to `ghcr.io/modnite/hearth-server` on version tags.
