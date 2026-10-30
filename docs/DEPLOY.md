# Deploying the Hearth server

## 1. The basics

```sh
sh scripts/setup.sh
docker compose up -d
```

`setup.sh` writes `.env` with a random `SESSION_SECRET` and LiveKit secret. It never overwrites an existing `.env`. Everything in [`.env.example`](../.env.example) is optional except `SESSION_SECRET`.

The server listens on `8080` (`HEARTH_PORT`). Set `HEARTH_BIND=127.0.0.1` if a reverse proxy on the same machine is the only thing that should reach it.

Check it: `curl http://localhost:8080/api/server/info`. Then open `/admin`.

## 2. A domain with HTTPS

Browsers only allow camera and microphone on HTTPS, and people expect it. Point a DNS name at the machine, open ports 80 and 443, then:

```sh
# in .env
HEARTH_DOMAIN=chat.example.com
docker compose --profile tls up -d
```

Caddy gets and renews the certificate by itself. It proxies the app and LiveKit's signalling.

Already have a reverse proxy (nginx, Traefik, Cloudflare Tunnel)? Skip the `tls` profile and proxy to `HEARTH_PORT`. Forward WebSocket upgrades on `/ws` and keep the `X-Forwarded-*` headers (the server trusts the proxy for client addresses).

## 3. Voice and video

Calls use [LiveKit](https://livekit.io). The `calls` profile runs it next to the server.

```sh
# in .env
LIVEKIT_PUBLIC_URL=wss://chat.example.com      # with the tls profile; ws://YOUR-LAN-IP:7880 for home use only
PUBLIC_IP=203.0.113.7                          # optional on a VPS; blank on a home line detects it

sh scripts/render-livekit.sh                   # writes infra/livekit.yaml
docker compose --profile calls up -d           # (add --profile tls for HTTPS)
```

Forward on your router: `7881/tcp` and `50100-50199/udp` (the range is `LIVEKIT_UDP_RANGE_START` and `_END`). LiveKit runs on the host network, which Docker Desktop on Windows and macOS does not support; on those, run LiveKit on a Linux machine and point `LIVEKIT_PUBLIC_URL` and `LIVEKIT_INTERNAL_URL` at it.

No STUN or TURN server is contacted by the server side. If your clients sit behind networks that block UDP entirely, LiveKit falls back to ICE-over-TCP on `7881`.

The **Overview** tab of the panel shows whether calls are set up and whether the server can reach LiveKit.

## 4. Configuration: panel, environment, defaults

Each setting has a default, an environment variable and a place in the panel. A value saved in the panel wins over the environment; "Use the environment value" next to it puts it back. The panel saves to `config.json` in the data folder (readable only by its owner).

| Setting | Environment | Applies |
|---|---|---|
| Server name, welcome note | `HEARTH_NAME`, `HEARTH_MOTD` | at once |
| Who can create an account | `REGISTRATION` (`invite` or `open`) | at once |
| House key | `REGISTRATION_KEY` | at once |
| Backups on/off, space per person, largest file | `BACKUP_STORAGE`, `BACKUP_QUOTA_MB`, `BACKUP_MAX_FILE_MB` | at once |
| Built-in browser proxy | `BROWSE_PROXY` (`on`/`off`) | at once |
| Public address | `HEARTH_DOMAIN` | restart |
| LiveKit address, internal address, key, secret | `LIVEKIT_URL`, `LIVEKIT_INTERNAL_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | restart |
| Web push keys and contact | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | restart |

Not editable in the panel, on purpose: `SESSION_SECRET` and the data folder (`DATA_DIR`).

With the compose file, the **Restart server** button in the panel works (Docker restarts the container when it exits). Outside Docker the button is hidden; restart however you run it.

### Web push keys

```sh
cd server && npm ci && npm run vapid
```

Put the pair in the panel or in `.env`.

## 5. Backing up and moving

All state is in the `hearth_data` volume. To back it up while running:

```sh
docker run --rm -v hearth_hearth_data:/data -v "$PWD":/out alpine tar czf /out/hearth-data.tgz -C /data .
```

(The volume is named `<project>_hearth_data`; `docker volume ls` shows the exact name.) For a perfectly consistent copy, stop the server for the few seconds the copy takes.

To move to another machine: install the same way, stop the server, restore the folder into the new volume, start it.

## 6. Upgrading and pinning

```sh
git pull && docker compose up -d --build
```

Pin what you run: use a release tag (`git checkout v1.0.0`) and set `LIVEKIT_TAG`. Published images, when you want to skip building, are `ghcr.io/modnite/hearth-server:<version>`; set `HEARTH_IMAGE` to use one.

## 7. Security notes

- Change nothing about `SESSION_SECRET` after people are signed in unless you want to sign everyone out.
- The admin panel is the same server: protect `/admin` like the rest (HTTPS, strong administrator passwords, two-step sign-in on administrator accounts).
- Open registration is limited to five new accounts an hour from one address; invite-only is the safer default.
- The built-in browser proxy fetches pages for signed-in people. Switch it off in Settings if you do not want your server doing that.
- Run the server as the unprivileged `node` user (the image does). The container filesystem is otherwise ordinary; the data volume is the only thing that needs to be writable.

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| `docker compose up` says `SESSION_SECRET` is required | run `sh scripts/setup.sh` (or set it in `.env`) |
| Panel says calls "set up, not reachable" | the server cannot reach `LIVEKIT_INTERNAL_URL`; with the `calls` profile it is `http://host.docker.internal:7880` |
| Clients cannot connect on a LAN | the clients need the machine's address, not `localhost`; use the connect address on the Overview tab |
| A client works over HTTP but not camera or microphone | camera and microphone need HTTPS (see section 2) |
| Lost every administrator password | `docker compose exec hearth node scripts/admin-cli.mjs reset-password <username>` prints a temporary one; `make-admin <username>` promotes an account; `list` shows who exists |
