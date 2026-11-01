# The Hearth server image. Build from the repository root:  docker build -t hearth-server .
# Reproducible: pinned Node major, dependencies installed from package-lock.json with `npm ci`.

# --- build: install everything, compile, then drop the dev dependencies ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 and sharp are native modules; keep a toolchain in case no prebuilt binary matches.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src
COPY server/scripts ./scripts
RUN npm run build \
    && npm prune --omit=dev

# --- runtime: slim, no toolchain, no dev dependencies, not root ---
FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/modnite/hearth-server"
LABEL org.opencontainers.image.description="The Hearth server"
LABEL org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/scripts/admin-cli.mjs ./scripts/admin-cli.mjs
COPY --from=build --chown=node:node /app/scripts/init-stack.mjs ./scripts/init-stack.mjs
COPY --from=build --chown=node:node /app/scripts/upnp.mjs ./scripts/upnp.mjs
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
