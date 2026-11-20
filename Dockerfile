# The game server.
#
# Two stages: one that installs every workspace dependency and builds, and a
# runtime that carries only what the server needs to run. better-sqlite3 is a
# native module, so the build stage needs a toolchain and the runtime does not.

# --- build ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build

# node-gyp needs python3, make and g++ to compile better-sqlite3. git is for
# pnpm, not for us: colyseus declares `@colyseus/uwebsockets-transport` as a
# required peer, and that resolves `uWebSockets.js` from a git remote, so the
# install shells out to git whether or not the server imports any of it. A
# slim image has no git, and this stage had never been built, so nothing had
# ever found that out. They all stay in this stage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Manifests first, so a change to source alone reuses the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY tools/bot/package.json tools/bot/
COPY tools/soak/package.json tools/soak/
COPY tools/shots/package.json tools/shots/
COPY tools/perf/package.json tools/perf/
COPY tools/verify/package.json tools/verify/

# Fetch the one git dependency over HTTPS rather than SSH.
#
# The lockfile pins `uWebSockets.js` to `git@github.com:uNetworking/...`,
# which needs a key this image has no business carrying. Git's
# config-through-environment rewrites it, which is the same two lines
# `.github/workflows/ci.yml` carries and for the same reason. Tried first as
# a pnpm `overrides` and then as a `packageExtensions` entry, so the fix
# would live in the lockfile and cover every clone at once: pnpm applies
# neither to a git-URL dependency, and restored the SSH form each time the
# entry was re-resolved.
ENV GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf \
    GIT_CONFIG_VALUE_0=git@github.com:

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @marque/server run build

# Drop everything the server does not need at runtime, including the client,
# the tools and every devDependency.
RUN pnpm --filter @marque/server --prod deploy --legacy /app/runtime

# --- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

# The data directory is a mount point in production. Owned by the node user,
# because the server does not run as root.
RUN mkdir -p /data && chown node:node /data

WORKDIR /app
COPY --from=build --chown=node:node /app/runtime ./

USER node

EXPOSE 2567

ENV PORT=2567 \
    DATABASE_URL=/data/marque.db \
    SNAPSHOT_DIR=/data/snapshots

# The health endpoint the host polls. Kept here as well as in the host config
# so `docker run` alone reports an unhealthy container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2567)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Straight to node, with no shell and no init wrapper in between, so SIGTERM
# reaches the process that handles it and the graceful shutdown runs.
CMD ["node", "dist/server.mjs"]
