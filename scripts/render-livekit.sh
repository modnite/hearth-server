#!/bin/sh
# Render infra/livekit.yaml from the template, filling in the current public IP.
#
# The public IP comes from PUBLIC_IP (environment or .env) or from a plain
# HTTPS lookup (PUBLIC_IP_URL) — never STUN. Run this on boot and on a timer;
# it only restarts LiveKit when the IP actually changed, so an IP that changes
# at 3am costs one short blip.
#
# Environment variables take precedence over .env, the same as docker compose.
# Safe under `set -eu` and safe to run when .env is absent (if the needed
# variables are exported); it never executes .env as shell code.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

ENV_FILE=.env

# Print the last assignment of KEY in .env, without sourcing the file. Handles
# CRLF line endings, surrounding whitespace and simple quoting.
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$ENV_FILE" \
    | tail -n 1 \
    | tr -d '\r' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
          -e 's/^"\(.*\)"$/\1/' \
          -e "s/^'\(.*\)'$/\1/"
}

# Environment first, then .env (docker compose's precedence).
pick() {
  value=$(printenv "$1" 2>/dev/null || true)
  if [ -n "$value" ]; then
    printf '%s' "$value"
  else
    env_get "$1"
  fi
}

require() {
  if [ -z "$2" ]; then
    echo "[render-livekit] $1 is not set." >&2
    echo "  Copy .env.example to .env and fill it in, or export $1." >&2
    exit 1
  fi
}

PUBLIC_IP=$(pick PUBLIC_IP)
PUBLIC_IP_URL=$(pick PUBLIC_IP_URL)
LIVEKIT_API_KEY=$(pick LIVEKIT_API_KEY)
LIVEKIT_API_SECRET=$(pick LIVEKIT_API_SECRET)
LIVEKIT_UDP_RANGE_START=$(pick LIVEKIT_UDP_RANGE_START)
LIVEKIT_UDP_RANGE_END=$(pick LIVEKIT_UDP_RANGE_END)
LIVEKIT_TCP_PORT=$(pick LIVEKIT_TCP_PORT)

: "${PUBLIC_IP_URL:=https://api.ipify.org}"
: "${LIVEKIT_UDP_RANGE_START:=50100}"
: "${LIVEKIT_UDP_RANGE_END:=50199}"
: "${LIVEKIT_TCP_PORT:=7881}"

require LIVEKIT_API_KEY "$LIVEKIT_API_KEY"
require LIVEKIT_API_SECRET "$LIVEKIT_API_SECRET"

if [ "${#LIVEKIT_API_SECRET}" -lt 32 ]; then
  echo "[render-livekit] warning: LIVEKIT_API_SECRET is shorter than 32 characters (LiveKit recommends 32+)." >&2
fi

# --- sanity-check the ports --------------------------------------------------
is_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

is_port "$LIVEKIT_TCP_PORT" || {
  echo "[render-livekit] LIVEKIT_TCP_PORT must be a port 1-65535, got '$LIVEKIT_TCP_PORT'" >&2
  exit 1
}
is_port "$LIVEKIT_UDP_RANGE_START" || {
  echo "[render-livekit] LIVEKIT_UDP_RANGE_START must be a port 1-65535, got '$LIVEKIT_UDP_RANGE_START'" >&2
  exit 1
}
is_port "$LIVEKIT_UDP_RANGE_END" || {
  echo "[render-livekit] LIVEKIT_UDP_RANGE_END must be a port 1-65535, got '$LIVEKIT_UDP_RANGE_END'" >&2
  exit 1
}
if [ "$LIVEKIT_UDP_RANGE_END" -le "$LIVEKIT_UDP_RANGE_START" ]; then
  echo "[render-livekit] LIVEKIT_UDP_RANGE_END ($LIVEKIT_UDP_RANGE_END) must be greater than LIVEKIT_UDP_RANGE_START ($LIVEKIT_UDP_RANGE_START)" >&2
  exit 1
fi

# --- find the public IP (never STUN) -----------------------------------------
IP=$PUBLIC_IP
if [ -z "$IP" ] && command -v curl >/dev/null 2>&1; then
  IP=$(curl -fsS --max-time 10 "$PUBLIC_IP_URL" 2>/dev/null || true)
fi
if [ -z "$IP" ] && command -v wget >/dev/null 2>&1; then
  IP=$(wget -qO- --timeout=10 "$PUBLIC_IP_URL" 2>/dev/null || true)
fi
IP=$(printf '%s' "$IP" | tr -d ' \t\r\n')

if [ -z "$IP" ]; then
  echo "[render-livekit] could not determine the public IP." >&2
  echo "  Tried PUBLIC_IP and the HTTPS lookup at $PUBLIC_IP_URL." >&2
  echo "  Set PUBLIC_IP in .env (or export it) and re-run." >&2
  exit 1
fi

if ! printf '%s\n' "$IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$|^[0-9a-fA-F:]+$'; then
  echo "[render-livekit] '$IP' does not look like an IP address; refusing to write it." >&2
  echo "  (Check PUBLIC_IP_URL — it should return just an IP, e.g. https://api.ipify.org)" >&2
  exit 1
fi

# A private node_ip cannot be reached by remote clients. That is fine for a
# localhost dev run, but almost certainly wrong on a home box.
case "$IP" in
  10.*|192.168.*|127.*|169.254.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|::1|fe80:*|fc*|fd*)
    echo "[render-livekit] warning: $IP is a private/loopback address." >&2
    echo "  Remote clients will not reach LiveKit through your router." >&2
    ;;
esac

# --- render the config -------------------------------------------------------
if [ -d infra/livekit.yaml ]; then
  echo "[render-livekit] infra/livekit.yaml is a directory (Docker created it when the file was missing)." >&2
  echo "  Remove it (rm -rf infra/livekit.yaml) and re-run." >&2
  exit 1
fi

# Escape characters that are special in a sed replacement.
sed_escape() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

TMP=$(mktemp "infra/livekit.yaml.XXXXXX")
trap 'rm -f "$TMP"' EXIT HUP INT TERM

sed \
  -e "s|__NODE_IP__|$(sed_escape "$IP")|g" \
  -e "s|__TCP_PORT__|$(sed_escape "$LIVEKIT_TCP_PORT")|g" \
  -e "s|__UDP_START__|$(sed_escape "$LIVEKIT_UDP_RANGE_START")|g" \
  -e "s|__UDP_END__|$(sed_escape "$LIVEKIT_UDP_RANGE_END")|g" \
  -e "s|__API_KEY__|$(sed_escape "$LIVEKIT_API_KEY")|g" \
  -e "s|__API_SECRET__|$(sed_escape "$LIVEKIT_API_SECRET")|g" \
  infra/livekit.yaml.tmpl > "$TMP"
mv "$TMP" infra/livekit.yaml
trap - EXIT HUP INT TERM

PREV=
if [ -f infra/.public-ip ]; then
  PREV=$(tr -d ' \t\r\n' < infra/.public-ip)
fi
printf '%s\n' "$IP" > infra/.public-ip

echo "[render-livekit] wrote infra/livekit.yaml with node_ip=$IP"

# --- restart LiveKit only when the IP actually changed -----------------------
if [ "$PREV" != "$IP" ]; then
  if command -v docker >/dev/null 2>&1 && docker compose ps livekit >/dev/null 2>&1; then
    if docker compose ps --status running --quiet livekit 2>/dev/null | grep -q .; then
      echo "[render-livekit] IP changed (${PREV:-none} -> $IP); recreating livekit"
      docker compose up -d --force-recreate livekit
    fi
  fi
fi
