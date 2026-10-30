# Changelog

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
