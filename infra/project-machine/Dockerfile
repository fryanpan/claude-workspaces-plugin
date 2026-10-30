# One project machine: the board server, cloudflared and the lead agent.
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

# Claude Code for the lead agent: the linux-x64 build from npm, pinned by
# version and checked against the registry's sha512 before it is installed.
# Fly machines are x86-64. Root owns the binary, so the lead cannot replace
# it, and the lead's environment turns the updater off (entrypoint.sh).
FROM oven/bun:1.3.10-debian@sha256:367842b35abbdf23f39e23c71f3a08eee940ff2679a14e08a5afcf4a1436cd89 AS claude
ARG CLAUDE_CODE_VERSION=2.1.314
ARG CLAUDE_CODE_SHA512=620d1ae66a5d9060a52b4ae014cc5b096656df066daa03a16236c84802eac8be6d7c00c7857f4cb3a131034fde7df81227d31a59f1cc3e7b6bc9e386e8c93a1d
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL -o /tmp/claude.tgz \
    "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-${CLAUDE_CODE_VERSION}.tgz" \
  && echo "${CLAUDE_CODE_SHA512}  /tmp/claude.tgz" | sha512sum -c - \
  && tar -xzf /tmp/claude.tgz -C /tmp package/claude \
  && install -m 0755 /tmp/package/claude /usr/local/bin/claude

FROM oven/bun:1.3.10-debian@sha256:367842b35abbdf23f39e23c71f3a08eee940ff2679a14e08a5afcf4a1436cd89
# Every home is 0700: a user's files are its own.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client tini tmux \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 10001 --create-home --shell /usr/sbin/nologin cw \
  && useradd --uid 10002 --create-home --shell /usr/sbin/nologin cwtunnel \
  && useradd --uid 10003 --create-home --shell /usr/sbin/nologin cwbackup \
  && useradd --uid 10004 --create-home --shell /usr/sbin/nologin lead \
  && chmod 0700 /home/cw /home/cwtunnel /home/cwbackup /home/lead
COPY --from=claude /usr/local/bin/claude /usr/local/bin/claude
# The lead clones and pushes its project's repo over SSH with a deploy key
# (lead.sh); GitHub's host keys are pinned, not learned on first use.
COPY infra/project-machine/github-known-hosts.txt /etc/ssh/ssh_known_hosts
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY --from=build /app /app
WORKDIR /app
ENV NODE_ENV=production \
  CW_DATA_DIR=/data/cw
# The entrypoint stays root to supervise and starts each child as its own
# user: the server as `cw`, cloudflared as `cwtunnel`, the backup upload as
# `cwbackup`, the lead agent as `lead`, so no child's user can read another's
# secrets (entrypoint.sh).
# `-s`: Fly's own init is PID 1, so tini registers as a subreaper to reap.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/app/infra/project-machine/entrypoint.sh"]
