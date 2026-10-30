#!/bin/sh
# First-time setup: write .env with fresh random secrets and, where calls can work, set them up too.
# Safe to run again; it never overwrites an existing .env.
#
#   sh scripts/setup.sh                      # then:  docker compose up -d   and open http://localhost:8080/admin
#   HEARTH_DOMAIN=chat.example.com sh scripts/setup.sh
#   sh scripts/setup.sh --no-calls           # chat and backups only, no voice or video
#   PUBLIC_IP=203.0.113.7 sh scripts/setup.sh
#
# Voice and video need LiveKit, which runs on the host network (Linux only). On Linux it is on by default: this script writes
# COMPOSE_PROFILES=calls into .env and renders infra/livekit.yaml. On Docker Desktop (Windows, macOS) it is left off.
set -eu
cd "$(dirname "$0")/.."

NO_CALLS=0
for arg in "$@"; do
  case "$arg" in
    --no-calls) NO_CALLS=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ -f .env ]; then
  echo ".env already exists, leaving it alone."
  exit 0
fi

rand() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

DOMAIN=${HEARTH_DOMAIN:-localhost}

# Calls: on where LiveKit can use the host network.
CALLS=1
WHY=""
if [ "$NO_CALLS" = 1 ]; then CALLS=0; WHY="you asked for --no-calls"
elif [ "$(uname -s)" != "Linux" ]; then CALLS=0; WHY="this is not Linux"
elif command -v docker >/dev/null 2>&1 && docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qi 'docker desktop'; then
  CALLS=0; WHY="Docker Desktop has no host networking"
fi

# The address clients use for the call connection: the domain if there is one, else this machine's address on the network.
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ "$DOMAIN" != "localhost" ]; then LIVEKIT_URL="wss://$DOMAIN"; else LIVEKIT_URL="ws://${LAN_IP:-localhost}:7880"; fi

# The address the internet reaches this machine at, for the media ports. A VPS has it fixed; a home line is looked up (a plain HTTPS request).
PUBLIC_IP=${PUBLIC_IP:-}
if [ "$CALLS" = 1 ] && [ -z "$PUBLIC_IP" ] && command -v curl >/dev/null 2>&1; then
  PUBLIC_IP=$(curl -fsS --max-time 8 "${PUBLIC_IP_URL:-https://api.ipify.org}" 2>/dev/null | tr -d ' \r\n' || true)
fi

{
  echo "# Written by scripts/setup.sh. See .env.example for everything you can set."
  echo "HEARTH_DOMAIN=$DOMAIN"
  echo "SESSION_SECRET=$(rand 32)"
  echo
  echo "# Voice and video (LiveKit)"
  if [ "$CALLS" = 1 ]; then echo "COMPOSE_PROFILES=calls"; else echo "# COMPOSE_PROFILES=calls    # switched on by setup.sh on Linux"; fi
  echo "LIVEKIT_API_KEY=hearth"
  echo "LIVEKIT_API_SECRET=$(rand 32)"
  echo "LIVEKIT_PUBLIC_URL=$LIVEKIT_URL"
  echo "LIVEKIT_INTERNAL_URL=http://host.docker.internal:7880"
  echo "PUBLIC_IP=$PUBLIC_IP"
} > .env
chmod 600 .env 2>/dev/null || true
echo "Wrote .env with new random secrets."

if [ "$CALLS" = 1 ]; then
  if [ -z "$PUBLIC_IP" ]; then
    echo "Could not find this machine's public address. Set PUBLIC_IP in .env, then run: sh scripts/render-livekit.sh" >&2
  else
    sh scripts/render-livekit.sh
  fi
  echo
  echo "Voice and video: on. Forward these on your router to this machine:"
  echo "  7881/tcp and 50100-50199/udp"
  echo "Browsers only allow camera and microphone over HTTPS: use a domain with  docker compose --profile tls up -d"
else
  echo
  echo "Voice and video: off ($WHY). Chat, groups and backups work without it."
fi
echo
echo "Next:  docker compose up -d"
echo "Then open http://localhost:8080/admin to create the first administrator."
