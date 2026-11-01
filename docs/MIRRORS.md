# Mirrors

A mirror is another Hearth server that keeps a live copy of this one. If this server goes down the mirror takes over by itself, and when this server is back the mirror hands everything back by itself. Nobody has to do anything at the moment it matters. You can have as many mirrors as you like.

## Link a mirror

1. On the main server open the admin panel, **Mirrors**, **Add a mirror**. Check the address and press **Make code**.
2. On the other server open its admin panel. On a new server choose "This server will be a mirror of another one" on the first screen. On a server with people already, **Mirrors**, **Make this a mirror of another server**. Paste the code.

The code works once and carries the key the servers share, so keep it private. The mirror's own data is replaced by a copy of the main server's; if it had any, a dated copy is kept in `replaced/`. Both servers must be able to reach each other at the addresses shown on the Mirrors page.

For an unattended setup give the mirror `HEARTH_MIRROR_CODE` and `HEARTH_PUBLIC_URL` and it links itself at start.

## What happens

- A mirror copies the database and the files (`uploads/` and `backups/`) every few seconds, only when something changed. Sign-ins are copied too, so people stay signed in on the mirror.
- Panel settings that belong to the whole server (name, welcome note, joining rules, backup limits, browser, crash reports) are copied. Calls are not: a mirror needs its own LiveKit and its own call settings.
- When nobody is serving for 30 seconds the mirror ranked first among those that answer takes over. Higher ranked mirrors follow it. Apps follow the list of servers they were given and move over by themselves, then back when the main server serves again.
- When the main server returns it asks the stand-in to stop, copies what was written meanwhile, and carries on. Its own data from before is kept as a dated file in `replaced/`.
- A mirror that is not serving answers `503 standby` to everything except the panel, the server information and the links between servers.

## The main server is gone for good

On a mirror press **Make this the main server**. The other mirrors follow it, and if the old main server ever returns it turns itself into a mirror of the new one.

## Notes

- Rank is the order mirrors were added; the main server is 0.
- After a broken network two servers can both take over. When they can see each other again the higher round wins, then the lower rank, and the other copies from it, keeping its own data as a dated file.
- Anything written to the main server in the last few seconds before it went down may not have reached the mirror yet.
- The web app moves between servers only if the mirror also serves it; the Android app talks to the servers directly.
