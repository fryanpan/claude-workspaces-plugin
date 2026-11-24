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
# Every root workspace glob has to be here, or bun.lock names a workspace the
# image lacks and `bun install --frozen-lockfile` refuses the build.
COPY templates ./templates
COPY infra/project-machine ./infra/project-machine
# The server imports the board router's path parser from here.
COPY infra/board-router-worker ./infra/board-router-worker
# Root owns /app and the server reads it as `cw`, so every user must be able to
# read it. A build folder can arrive with its folders at 0700, which root's
# own checks pass and `cw` cannot enter; the last step here sets the modes
# whatever the build folder's were.
RUN bun install --frozen-lockfile \
  && bun run packages/widget/scripts/build.ts \
  && bun run packages/workspaces-app/scripts/build.ts \
  && chmod -R a+rX /app

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

# Node for the lead's project tests (a project's Node unit tests and its
# Playwright suite): the official linux-x64 build of an LTS release, pinned by
# version and checked against nodejs.org's SHASUMS256.txt.
FROM oven/bun:1.3.10-debian@sha256:367842b35abbdf23f39e23c71f3a08eee940ff2679a14e08a5afcf4a1436cd89 AS node
ARG NODE_VERSION=26.13.1
ARG NODE_SHA256=518674de2b621728a5e4486f5fb3b7d2900bb3cc4aa97969edaa463db99f9778
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL -o /tmp/node.tgz \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" \
  && echo "${NODE_SHA256}  /tmp/node.tgz" | sha256sum -c - \
  && mkdir /opt/node \
  && tar -xzf /tmp/node.tgz -C /opt/node --strip-components=1 --no-same-owner

FROM oven/bun:1.3.10-debian@sha256:367842b35abbdf23f39e23c71f3a08eee940ff2679a14e08a5afcf4a1436cd89
# Every home is 0700: a user's files are its own. `cwboard` holds the server
# and the lead and nobody else: the lead's board socket is that group's
# (entrypoint.sh). `cwdevsrc` holds the lead and the dev server's user
# (`cwdev`) and nobody else: the dev server's folder is that group's.
# `nftables` loads the lead's network wall (lead-egress.ts) as a native table
# matched by `meta skuid`, which Fly's kernel has; `iptables` (nft and legacy,
# IPv4 and IPv6) is the fallback for a kernel with the owner match instead. `cwproxy` runs the proxy that is the wall's one way out
# (lead-proxy.ts); the wall does not hold it. `cwstore` sends the transcript
# store's spools (store-sender.ts) with the store's credential and nothing else.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git iptables nftables openssh-client tini tmux \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 10001 --create-home --shell /usr/sbin/nologin cw \
  && useradd --uid 10002 --create-home --shell /usr/sbin/nologin cwtunnel \
  && useradd --uid 10003 --create-home --shell /usr/sbin/nologin cwbackup \
  && useradd --uid 10004 --create-home --shell /usr/sbin/nologin lead \
  && useradd --uid 10005 --create-home --shell /usr/sbin/nologin cwdev \
  && useradd --uid 10006 --create-home --shell /usr/sbin/nologin cwrelease \
  && useradd --uid 10007 --create-home --shell /usr/sbin/nologin cwproxy \
  && useradd --uid 10008 --create-home --shell /usr/sbin/nologin cwstore \
  && groupadd --gid 10010 cwboard \
  && groupadd --gid 10011 cwdevsrc \
  && usermod -aG cwboard cw \
  && usermod -aG cwboard lead \
  && usermod -aG cwdevsrc cwdev \
  && usermod -aG cwdevsrc lead \
  && chmod 0700 /home/cw /home/cwtunnel /home/cwbackup /home/lead /home/cwdev /home/cwrelease /home/cwproxy /home/cwstore
COPY --from=claude /usr/local/bin/claude /usr/local/bin/claude
# Node on PATH as node, npm and npx. The base image's `node`, a link to bun,
# sits in a folder at the end of PATH, so this one wins.
COPY --from=node /opt/node /opt/node
RUN ln -s /opt/node/bin/node /opt/node/bin/npm /opt/node/bin/npx /usr/local/bin/
# Playwright's Chromium and the system libraries it needs, at build time: the
# lead's network wall does not list Playwright's download CDN, and the lead
# has no root for apt. PLAYWRIGHT_VERSION MUST EQUAL the project's
# @playwright/test version, because each Playwright release runs only the
# browser build it was released with. Root owns /opt/ms-playwright and every
# user can read it. The lead is given PLAYWRIGHT_BROWSERS_PATH and
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 by entrypoint.sh; change the path there
# too if it changes here.
ARG PLAYWRIGHT_VERSION=1.64.1
RUN PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
  && chmod -R a+rX /opt/ms-playwright \
  && rm -rf /root/.npm /var/lib/apt/lists/*
# The lead clones and fetches its project's repo over SSH with a deploy key
# (lead.sh); GitHub's host keys are pinned, not learned on first use.
COPY infra/project-machine/github-known-hosts.txt /etc/ssh/ssh_known_hosts
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY --from=build /app /app
WORKDIR /app
ENV NODE_ENV=production \
  CW_DATA_DIR=/data/cw
# The entrypoint stays root to supervise and starts each child as its own
# user: the server as `cw`, cloudflared as `cwtunnel`, the backup upload as
# `cwbackup`, the lead agent as `lead`, the dev server as `cwdev`, the release
# check as `cwrelease`, so no child's user can read another's secrets
# (entrypoint.sh).
#
# A release CI publishes runs against this image's packages and Bun
# (release-store.ts), and is checked against
# infra/project-machine/release-signing-key.pub, copied in above with the
# rest of that folder. Changing the key, Bun or bun.lock is an image deploy.
# `-s`: Fly's own init is PID 1, so tini registers as a subreaper to reap.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/app/infra/project-machine/entrypoint.sh"]
