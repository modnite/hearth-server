#!/bin/sh
# First-time setup: write .env with fresh random secrets. Safe to run again; it never overwrites an existing .env.
#
#   sh scripts/setup.sh                    # then:  docker compose up -d   and open http://localhost:8080/admin
#   HEARTH_DOMAIN=chat.example.com sh scripts/setup.sh
set -eu
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo ".env already exists, leaving it alone."
  exit 0
fi

rand() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

DOMAIN=${HEARTH_DOMAIN:-localhost}
cat > .env <<ENV
# Written by scripts/setup.sh. See .env.example for everything you can set.
HEARTH_DOMAIN=$DOMAIN
SESSION_SECRET=$(rand 32)

# Voice and video (only used with: docker compose --profile calls up -d)
LIVEKIT_API_KEY=hearth
LIVEKIT_API_SECRET=$(rand 32)
LIVEKIT_PUBLIC_URL=ws://localhost:7880
LIVEKIT_INTERNAL_URL=http://host.docker.internal:7880
ENV
chmod 600 .env 2>/dev/null || true

echo "Wrote .env with new random secrets."
echo "Next:  docker compose up -d"
echo "Then open http://localhost:8080/admin to create the first administrator."
