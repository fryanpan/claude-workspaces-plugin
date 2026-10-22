# One project machine: the board server and cloudflared.
#
# Built by `bun run machine:deploy`, from a `git archive` of one commit on
# Fly's remote builder (docs/process/project-machine.md).
#
# No secret is baked in. Every credential arrives at runtime as a Fly secret;
# the list is in fly.toml.

FROM oven/bun:1.3.10-debian@sha256:367842b35abbdf23f39e23c71f3a08eee940ff2679a14e08a5afcf4a1436cd89 AS build
WORKDIR /app
# Only what the server and its two browser bundles need: no .git, no data
# dir, no local node_modules.
COPY package.json bun.lock bunfig.toml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY demos ./demos
COPY infra/project-machine ./infra/project-machine
# The server imports the board router's path parser from here.
COPY infra/board-router-worker ./infra/board-router-worker
RUN bun install --frozen-lockfile \
  && bun run packages/widget/scripts/build.ts \
  && bun run packages/workspaces-app/scripts/build.ts

FROM cloudflare/cloudflared:2026.9.3@sha256:072c067d25ccbe61d46e18f0d0723255f2bb5304f7317caa95b27031520ff92c AS cloudflared

FROM oven/bun:1.3.10-debian@sha256:367842b35abbdf23f39e23c71f3a08eee940ff2679a14e08a5afcf4a1436cd89
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 10001 --create-home --shell /usr/sbin/nologin cw
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY --from=build /app /app
WORKDIR /app
ENV NODE_ENV=production \
  CW_DATA_DIR=/data/cw
# The entrypoint starts as root only to hand the volume to `cw`, then drops
# to it before starting anything (entrypoint.sh).
# `-s`: Fly's own init is PID 1, so tini registers as a subreaper to reap.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/app/infra/project-machine/entrypoint.sh"]
