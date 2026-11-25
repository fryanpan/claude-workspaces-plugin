# A project machine on Fly

One client project's board server runs on a Fly Machine of its own, reached
only through a Cloudflare Tunnel the machine dials out to, with its data dir
backed up, encrypted, to a bucket of the project's own. Every step is a
script an agent runs from the Mac; the files are in `infra/project-machine/`.
`<project>` below is a short lower-case name, used for every resource.

## What is on the machine

| Part | What it does |
| --- | --- |
| `Dockerfile` | The board server and both browser bundles, cloudflared, Claude Code (pinned by version and sha512), tmux and an SSH client, and seven users: `cw` for the server, `cwtunnel` for cloudflared, `cwbackup` for the backup upload, `lead` for the lead agent, `cwdev` for the project's dev server, `cwrelease` for the release check, `cwstore` for the transcript store's sender |
| `fly.toml` | One machine, one volume at `/data`, no public service ports. `deploy.ts` writes the app name and size in at deploy time |
| `entrypoint.sh` | Stays root and starts the server on `127.0.0.1:8787` as `cw`, the tunnel as `cwtunnel`, the lead agent's supervisor as `lead`, the project's dev server as `cwdev` when one is configured, a loopback health check, the backup loop and the release check as `cwrelease`; if any stops, the machine exits and Fly restarts it. Each child gets only its own secrets, so no child's user can read another's |
| `lead.sh` | Keeps one Claude Code session running in a tmux session named `lead`, and starts it again when it ends (below) |
| `github-known-hosts.txt` | GitHub's SSH host keys, installed as `/etc/ssh/ssh_known_hosts` for the lead's git |
| `backup-once.sh`, `backup.ts` | Tars the data dir and the agents' session transcripts and encrypts them to the project's public key as `cw`, then PUTs the file to the bucket as `cwbackup`. Every 6 hours, the first an hour after boot |
| `release-cli.ts`, `release-store.ts`, `release-manifest.ts` | Checks for a newer signed release, chooses which app the server boots, and rolls a release back that did not stay up ("Releases", below) |
| `restore.ts` | Decrypts a downloaded snapshot onto a data dir (and a transcripts dir) that is missing or empty. Refuses anything else |
| `store-uploader.ts`, `store-sender.ts`, `store-spool.ts` | Every minute, seals the new lines of each session transcript and analytics log into a spool, as the user that owns them (`cw`, then `lead`); `cwstore` puts what it finds there into the transcript store ("The transcript store", below) |

**What a snapshot holds.** The data dir, which carries every board's docs,
tasks, analytics events (`workspaces/<board>.events.jsonl`) and agent notes
(`workspaces/<board>.agent-notes.jsonl`); and Claude Code's session
transcripts. The entrypoint points the `cw` user's `~/.claude/projects` at
`/data/claude-projects` on the volume, so transcripts survive a restart and
are snapshotted with the board. The rest of `~/.claude`, which holds Claude
Code's own credentials, stays off the volume and out of every snapshot.

**The machine holds only the public half of the backup key.** It can write
snapshots but cannot read one back, and the bucket sees only ciphertext.
The private half (the identity) is in the Mac's Keychain as
`cw-<project>-backup-identity`, and without it no snapshot restores.

**The bucket credential is write-only.** It may put objects under
`snapshots/` and cannot read, list or delete them. What it can still do is
in the [README](../../infra/project-machine/README.md#why-tigris-for-the-bucket).

**Claude calls spend the org's own key and no other.** The server reads
`CW_ORG_ANTHROPIC_API_KEY` (a Fly secret) for every Claude call, and nothing
else: no Mac Keychain item, no eval key, no `ANTHROPIC_API_KEY`, no access
token. Without it every Claude call is refused, and the boot log names the
secret to set. At boot the server also removes every other org's key and every
gh token from its own environment, and logs an error if a gh login file is on
disk. `CW_PROJECT_PROFILE` picks the features: `standard` (the default) runs
each one whose key is set; `claude-only` turns off transcription, ElevenLabs and
Gemini, and the doc and board pages say so
(`packages/server/src/project-profile.ts`). `machine:deploy` sets the key
only when the Keychain holds `cw-<project>-anthropic-api-key`, which a person
adds; a project without one runs with Claude off.

## What the deploy needs

Since the keeper retired ([keeper.md](keeper.md), "Retired"), the Mac holds
no Fly org token and no Cloudflare token. Two workflows hold them:

- **Making a project** (its app, volume, bucket, backup key, push keys and
  tunnel token) is `.github/workflows/fly-provision.yml`, dispatched on main
  with the project's name once `machines.json` lists it. Its `outputs` job,
  in `cloudflare-prod`, reads the tunnel token and the Access settings and
  seals them to `fly-org`. Its `provision` job, in `fly-org` with the org
  token, runs `machine:deploy`. What that run makes for the Mac (the backup
  identity, the bucket's admin key, the Mac's token for the app) is sealed to
  the Mac and stored by `bun run handoff:pull` (`infra/handoff/`).
- **Every other `fly` call on the Mac** runs with that app's own token, which
  `.github/workflows/fly-ci-tokens.yml` cuts every Monday (the app, Fly's
  builder and WireGuard, so `fly ssh` and `fly logs` work; 14 days). A
  missing or expiring token is pulled on the first `fly` call that needs it.
  A command that names no app, or makes one, is refused with a pointer to
  `fly-provision.yml`.

So the Mac needs `flyctl` (`brew install flyctl`, no `fly auth login`), its
handoff key (`bun run handoff:keygen mac`, once), and `gh` signed in.

## Deploy

```bash
bun run machine:deploy --project <project> [--memory 512] [--volume-gb 1] [--region sjc]
    [--tunnel quick|named] [--tf-env prod|staging] [--dry-run]
```

It reads what exists and does only what is missing. Steps 1 to 5 and the
push keys run only inside `fly-provision.yml`; on the Mac a run that would
make one is refused before anything changes, naming the workflow.

1. The app `cw-<project>` in the shared org, on a private network of the same
   name, so no other project's machine can reach it.
2. The volume `cw_data`.
3. The backup key pair. The identity is sealed to the Mac, which stores it
   in the Keychain and never replaces it: a new one would orphan every
   snapshot.
4. The Tigris bucket `cw-<project>-backups`. Its admin credential is sealed
   to the Mac, which stores it as `cw-<project>-bucket-admin`; the machine
   never gets it.
5. The machine's write-only credential (`cw-<project>-backup-writer`), and
   the bucket made a Tigris snapshot bucket, so a snapshot the machine
   overwrites stays readable at its earlier version. A snapshot bucket cannot
   expire objects, so old snapshots are kept; a 30-day rule an older run set
   is removed first, because Tigris refuses the switch while one exists.
6. The machine's secrets, set through `fly secrets import` on stdin so no
   value is ever an argument. Each is set only when `fly secrets list` does
   not name it yet; a dry run prints each name and where its value comes
   from, never the value.
7. The image, built by Fly's remote builder from `git archive <ref>` (HEAD by
   default), so no local `node_modules`, data dir or uncommitted file is in
   it. It is labelled with the commit; a run on the same commit and size does
   not rebuild.

A run over a finished project prints `nothing to do`. The last lines name the
machine, its commit and size, and the tunnel address.

### The owner and Access settings

The same step gives the server what it needs to admit its owner on the
project's own hostname:

| Setting | From |
| --- | --- |
| `CW_OWNER_EMAIL` | the Keychain's `cw-board-owner-email` |
| `CW_PUBLIC_BASE_URL` | `https://` and the project's router host |
| `CW_SIGNIN_ORIGIN` | the same: the origin Better Auth signs in at |
| `CF_ACCESS_TEAM_DOMAIN` | the account's Access organization (`auth_domain`) |
| `CF_ACCESS_AUD` | the Access application `board <project>` |
| `CF_ACCESS_HOST_AUDS` | each of the project's hosts, to that audience |
| `CW_PROXIED_TRUSTED_HOSTS` | the project's hosts |
| `CW_SIGNIN` | `better-auth`, for a project with no Access application only |

Every row but the first comes from the Terraform outputs, so deploy reads no
Cloudflare API for them. Where they come from depends on whether the run
holds the state bucket's credential (`AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`, or `cloudflare-r2-tfstate` or the secret card's two
entries in the Keychain); `infra/project-machine/mac-outputs.ts` decides:

- **With the credential**, `terraform output` against the prod state, or the
  environment `--tf-env` names (`infra/cloudflare/outputs.ts`).
- **Without it, or when the state refuses it**, the newest sealed wall read (`wall-read.yml`, read with `gh` and
  opened with the Mac's handoff key, as `machine:wall-report` does). The
  Mac's Cloudflare credentials were retired, but its Keychain may still hold
  the revoked state key, so a `terraform init` the state bucket refuses with
  a 401 or 403 falls back here too, with one line saying the state was
  refused and which run, how old, it used instead. Any other failure (a
  network error, a 5xx) stops the run rather than use an older read. It holds
  prod's outputs only, so `--tf-env staging` without the credential fails.
  A read older than 36 hours, or no readable read at all, fails the run
  before Fly is touched, and the message names the fix:
  `gh workflow run wall-read.yml --ref main`.

`bun run signin:callbacks` reads the outputs the same way.

A project with no Access
application gets no Access settings, and the run says which settings it left
unset; it does not fail. Sign-in is Better Auth, so a new project is given no
Access application at all.

Such a project has only Better Auth in front of it, so the run trusts its
router host (`CW_PROXIED_TRUSTED_HOSTS`, the `CW_SIGNIN_ORIGIN` host) and
turns sign-in on (`CW_SIGNIN=better-auth`). Without both, the server answers
every browser `403 unknown_host`. `CW_SIGNIN` is set only by a run that also
holds the Google client, because the server refuses to boot on `better-auth`
without one. fly-provision.yml's run reads no Keychain, so it sets the trusted
host and leaves `CW_SIGNIN`, the client and the owner's address to the Mac's
next `bun run machine:deploy --project <name>`, which reads all three from the
Keychain. A project with an Access application gets exactly what it got
before: its Access hosts, and `CW_SIGNIN` left unset.

The router host is the project's own hostname, `<label>-<first label of the
one address>.<zone>`, which the board router routes once the project is in
`router.local.json` and CI has applied `bun run cf:sync-config`. It is also
the sign-in origin (`CW_SIGNIN_ORIGIN`) and what `bun run signin:callbacks`
lists. A project whose route is not in the state yet keeps its Access host;
where the two differ the run sets neither and says so, so a deploy never
moves an existing project's address. Outputs it cannot read at all fail the
run, because a named tunnel's id comes from them; `bun run signin:callbacks`
instead lists the Mac's lines and names the projects it could not list.

Not set by deploy: `CW_PROXIED_TRUSTED_EMAILS`, which defaults to
`CW_OWNER_EMAIL`, and the share settings (`CF_ACCESS_SHARE_AUD`,
`CW_SHARE_LINK_HOSTS`, `CF_SHARE_BASE_HOSTNAME`, `CF_ACCOUNT_ID`), which need
a share application this repo does not make per project. A setting that
exists is never set again, so a value that changed (an application made
again, a host added) takes `fly secrets unset <name>` and another run.

Volume size: 1 GB holds a board; a project with a staging site wants 20. Fly
keeps its own daily volume snapshots for five days on top of these backups.

Memory: `--memory` takes 256 to 16384 MB in steps of 256, and the deploy
picks the CPUs. Fly lets a shared CPU hold at most 2 GB, so a machine gets
the fewest shared CPUs that hold its memory: `shared-cpu-1x` up to 2048,
`2x` up to 4096, `4x` up to 8192 and `8x` up to 16384
([Fly's sizing rule](https://docs.fly.io/machines/guides-examples/machine-sizing),
`infra/project-machine/vm-size.ts`). A lead needs 2048 or more. A machine
that also runs a project's test suites is sized from their measured peak:
MOI's three PRs' suites at once peaked at about 7.7 GB, so it runs on 16384,
`shared-cpu-8x`.

### The tunnel

`--tunnel quick` (the default until the Cloudflare token exists) runs a
cloudflared quick tunnel: a random `trycloudflare.com` address, new on every
machine start, with no Cloudflare account. Its visitors carry `cf-ray` and no
Access identity, so the server answers them `403 unknown_host` on every
path. It proves the machine can be reached; it is not a way in.

`--tunnel named` is the production path. `machine:deploy` makes no
Cloudflare call; Terraform (`infra/cloudflare/README.md`, applied by CI on
main) makes the tunnel, for every project in `router.local.json` whose origin is
`<project>-origin.<zone>`. So the order is: add
`"<project>": "<project>-origin.<zone>"` to the router's `projects`, run
`bun run cf:sync-config` (it writes the config to GitHub and starts the
apply; the plan is in the run's log), wait for CI's apply, then dispatch
`fly-provision.yml` for the project. The apply makes:

1. The tunnel `cw-<project>`, configured from Cloudflare rather than from a
   file on the machine.
2. The tunnel's ingress: the project's own hostname,
   `<project>-<first label of the one address>.<zone>` (so
   `riverbend-workspaces.<zone>` beside `workspaces.<zone>`), to
   `http://localhost:8787`, and a 404 for every other hostname. That is the
   Host header the router Worker sends.
3. The origin hostname `<project>-origin.<zone>`: a proxied CNAME to
   `<tunnel id>.cfargotunnel.com`, and the project hostname's record and
   route for the router Worker.

Before terraform runs, the wrapper stops, having changed nothing, when it finds two
live tunnels of the name, a tunnel configured from a file, a record at the
origin hostname that is not a proxied CNAME to this tunnel, or an Access
application covering the origin hostname.

`machine:deploy` then reads the tunnel's account and id from `terraform
output`, refusing with the origin to give it when the state has none. When
the machine's `CLOUDFLARE_TUNNEL_TOKEN` is missing or `--refresh-tunnel-token`
asks for it, it sets the token `fly-provision.yml`'s `outputs` job read from
Cloudflare's API (`cfd_tunnel/<id>/token`, with `cloudflare-prod`'s token)
and sealed to `fly-org`. It goes through `fly secrets import` on stdin. The
token is never in the Terraform state, and no other run reads it: a run on
the Mac or in `fly.yml` that would set it is refused, naming the workflow. A tunnel Terraform remade has a new token: dispatch `fly-provision.yml` with
`refresh_tunnel_token` to set it again. A machine that ran a quick tunnel
loses its `CW_TUNNEL_MODE` secret, so it starts the named one.

### Releases: how new code reaches a machine

CI holds no credential for any machine. It publishes a signed release for
every commit on main that CI passed, and each machine installs it itself.
An image change (the Dockerfile, Bun, `bun.lock`, the release key,
`entrypoint.sh`) deploys from `fly.yml` when it merges.

1. **CI builds and signs.** `.github/workflows/server-release.yml` runs after
   CI passes on a push to main. It installs and builds the checkout the way the
   Dockerfile does, tars the same paths (`RELEASE_PATHS` in
   `release-publish.ts`) without the package store `node_modules/.bun`, and
   signs a manifest naming the tarball's SHA-256 with the Ed25519 key in the
   `server-release` environment's `CW_RELEASE_SIGNING_KEY`. Both are assets of
   the GitHub release `server-channel`: `cw-server-<sha>.tar.gz` (the last five
   kept) and `channel.json`. The manifest's serial is the commit's position on
   main (`git rev-list --count --first-parent`), and CI never replaces a
   higher serial with a lower one.
2. **The machine checks.** Every 300 seconds (`CW_RELEASE_POLL_SECONDS`) the
   `cwrelease` user, which holds no secret, reads `channel.json`
   (`release-cli.ts check`). It verifies the signature against
   `infra/project-machine/release-signing-key.pub` in the image before it
   reads anything else, and refuses a release that is not newer than what it
   runs, that failed here before, or that was built with another Bun or
   another `bun.lock` (that release needs an image deploy). Otherwise it
   downloads the tarball, checks its SHA-256 against the manifest, and exits;
   the machine stops, and Fly's restart policy starts it again.
3. **The boot tries it.** `entrypoint.sh` asks `release-cli.ts select` which
   app the server runs. A downloaded release is verified again, unpacked into
   `/data/releases/<sha>`, linked to the image's `node_modules/.bun`, and put
   on trial. When the server answers three probes in a row, 10 seconds apart,
   the trial becomes current and the release it replaced is kept as previous.
4. **A bad release rolls back.** A trial still set at the next boot did not
   stay up: its server exited, or it never answered inside the first bind's
   240 seconds plus three missed probes. That boot marks it failed, never
   downloads it again, and runs the current release. So a bad release costs
   two restarts and at most about five minutes of the board; nothing has to
   run on the Mac.

The machine runs, in order of preference: a trial, the current release if it
is newer than the image, the image's own app. `machine:deploy` writes the
image's serial into it (`image-release.json`), so a newer image beats an older
release on the volume. `/data/releases/state.json` holds current, previous,
the trial and the last 20 failures with their reasons.

Without `release-signing-key.pub` in the image the machine never updates
itself and logs `this machine does not update itself`. To turn it on, once:

```bash
bun infra/project-machine/release-publish.ts keygen --private-key <new file outside the repo>
```

That writes the private key (mode 600) and `release-signing-key.pub`. Put the
private key's text in the `server-release` environment as
`CW_RELEASE_SIGNING_KEY` (deployments from main only), commit the public key
through a PR; `fly.yml` deploys each machine's image when it merges, so each
image carries the key. Rotating the key is the same steps.

`infra/project-machine/machines.ts` still runs `machine:deploy` for every
machine in `machines.json`; nothing runs it on a schedule.

### Checking it

```bash
fly ssh console --app cw-<project> -C \
  "curl -s -H 'host: localhost:8787' http://127.0.0.1:8787/api/deploy"
```

The curl answers with a JSON `liveness` field (and a 501 for the deploy
half: a project machine takes new code from signed releases, "Releases"
above, and never from `POST /api/deploy`). `cat /data/releases/state.json`
over the same console names the release it runs. Then add the project's boards under the machine's origin hostname in
the router's `BOARD_ORIGINS`.

## The lead agent

The project's lead agent is a Claude Code session on the machine, beside the
board server. It runs only when the machine has a board for it to lead and a
Claude Code sign-in:

```bash
bun run machine:deploy --project <project> --memory 2048 \
  --lead-board <boardId> \
  [--github-deploy-key <keychain entry> --lead-repo <owner/name>]
```

- `--lead-board` sets `CW_LEAD_BOARD`. Without a board no lead runs, and the
  deploy sends no sign-in, though the Mac's Keychain holds one.
- The sign-in is `CLAUDE_CODE_OAUTH_TOKEN`. A deploy takes it from the central
  list when the list holds a token (see [The central token list](#the-central-token-list)),
  and asks for no sign-in. With an empty list it is a token made for this org
  alone (re-review finding H2): the first deploy of an org with a lead runs
  `claude setup-token`, which opens Bryan's browser: one approval per org, and
  the token lasts a year. The deploy sets it on that org's app beside
  `CW_LEAD_TOKEN_ORG=<project>` and keeps it nowhere on the Mac, not in the
  Keychain and not in a file; the screen the approval prints is shown with the
  token hidden (`infra/project-machine/org-signin.ts`). A dry run asks for no
  approval and says one is due. CI never asks: a run there sets no sign-in
  and says why.
- The machine starts its lead only when `CW_LEAD_TOKEN_ORG` names its own
  org or, for a listed token, holds a digest of its org, the label and that
  exact token (`entrypoint.sh`). So a token with no marker, or one set over a
  listed marker, starts no lead. A token set by hand over an org-name marker
  still does. The next deploy on the Mac sees no
  `CW_LEAD_TOKEN_ORG` and sets the listed token `machines.json` pins on the
  project, refuses when the list holds tokens and none is pinned, or with an
  empty list asks for the org's approval.
- The Mac's walled lead keeps its own Keychain sign-in,
  `claude-lead-oauth-token` (`scripts/lead-sandbox-token.ts`); no org's lead
  is given it. `--claude-account` is gone.
- Revoke a sign-in made for one org at claude.ai/settings/claude-code; no other
  org loses its lead. `--refresh-lead` then makes the org a new one. With
  tokens on the list, `--refresh-lead` must name the pinned one with
  `--claude-token`.
- A deploy takes a listed token only where `machines.json` pins it on the
  project (`"leadToken": "<label>"`), so which org uses which sign-in is
  written down and merged (wall-off review H2). A project with no pin is
  refused while the list holds a token; the refusal names the first label no
  project pins, or the first listed when all are pinned. Orgs may share a
  label (Bryan, 2026-11-24), and a lead moves orgs between tokens to spread
  usage: change the pin, then `machine:tokens move`. With an empty list the
  deploy asks for the per-org browser approval, as before.
- `--claude-token <label>` must agree with the pin, and sets it again on a
  run that names it. Only a deploy of an image holding this code can set one.
- `--github-deploy-key` names a Keychain entry holding an OpenSSH private
  key, the project repo's deploy key; it becomes `CW_LEAD_GITHUB_DEPLOY_KEY`.
  The deploy sets it only once GitHub lists it read-only: it reads the deploy
  keys of each `--lead-repo` (repeatable) and `--push-repo` through `gh api
  repos/<repo>/keys`, and refuses a key that can write, a key on none of them,
  and a run that names no repo.
- A machine with a lead needs `--memory 2048` or more; the deploy refuses a
  smaller one.
- Each is set once, like every secret. A run that names a source sets that
  secret again. `--refresh-lead` also makes the org a new sign-in, with a
  new approval, and needs `--lead-board`; a deploy key is set again only when
  `--github-deploy-key` names it.

What the lead can reach:

- **Its user.** The session runs as `lead`, with an environment the
  entrypoint builds from nothing: its sign-in, its board's socket
  (`CW_BOARD_SOCKET`) and board (`CW_WORKSPACE_ID`), `CW_AGENT_NAME`
  (`<project>-lead` unless `CW_LEAD_AGENT_NAME` is set), the deploy key, and
  the updater turned off. It does not hold the server's Claude key, the
  tunnel token or the bucket credential, and no other user's process holds
  its sign-in or deploy key. The server's data dir is mode 700.
- **Its board, and no other.** The server listens on one unix socket per
  board in `/data/boards`, which is `cw:cwboard` mode 710; the group
  `cwboard` holds `cw` and `lead` and nobody else. The lead may enter the
  folder and may not list it. Only the lead's board's socket is the group's,
  mode 660, and every other socket is `cw`'s, mode 600, so `cwtunnel` and
  `cwbackup` reach none. A request
  on that socket is held to that board (`middleware/board-socket-door.ts`),
  which is how a walled lead on the Mac reaches its board too. The server
  admits loopback TCP only from itself (`CW_LOOPBACK_ALLOWED_UIDS`),
  and from cloudflared only for requests the edge stamped with `cf-ray`
  (`CW_LOOPBACK_EDGE_UIDS`, `middleware/loopback-uid-door.ts`). Every other
  uid, root's, the lead's and `cwbackup`'s among them, is refused, so the lead is
  never the owner that a loopback caller otherwise is, and neither is a
  user added later. A `fly ssh console` command that calls the REST runs as
  `cw` (`asCw`, `infra/project-machine/mac-ops.ts`).
- **Its repo.** `lead.sh` writes the deploy key to `~/.ssh/github_deploy_key`
  (mode 600) and points git's `core.sshCommand` at it. GitHub's host keys are
  pinned in the image (`/etc/ssh/ssh_known_hosts`), and an unknown host key
  is refused. Without a deploy key the lead has no GitHub access.
- **Its plugin.** The image's own copy (`--plugin-dir /app/packages/plugin`),
  from the same commit as the server, so it updates with each deploy.
- **Its test tools.** Node (an LTS release) and Playwright's Chromium with
  its system libraries are in the image, at `/opt/ms-playwright`, and the
  lead gets `PLAYWRIGHT_BROWSERS_PATH` and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`,
  because the network wall does not list Playwright's CDN. The image's
  `PLAYWRIGHT_VERSION` must equal the project's `@playwright/test` version.
- **Its files.** Its working folder is `/data/lead/work` and its transcripts
  are in `/data/lead/claude-projects`, both on the volume. `/data/lead` is
  `lead` mode 700, so the server cannot read it, and no doc can be bound to a
  file there. A folder bind over the socket is refused
  (`board-socket-lead-binds.test.ts`). The lead can still write `/tmp`, which
  the server can read, so a person must not bind a doc or folder under `/tmp`
  on this machine. The transcripts are not in the snapshots yet: the snapshot
  runs as `cw`. They do reach the transcript store, through the lead's own
  reader ("The transcript store", below).
- **Its memory.** A ceiling of 1280M unless `CW_LEAD_MEMORY_MAX` is set, so a
  lead that grows is killed alone and the server keeps running. Where the
  machine has a cgroup v2 memory controller (the entrypoint mounts cgroup2 at
  `/sys/fs/cgroup` if nothing is mounted there), the lead is in a group of its
  own, `cw-lead`, with that `memory.max`, and the boot log says `capped at
  1280M by its cgroup`. Where it has none, which is what cw-moi's boot log
  showed on 6 November, a root watchdog (`lead-memory.sh`) adds up the PSS of
  every process of the `lead` uid every 2 seconds and kills them all with
  SIGKILL once the total passes the cap; the log says `capped at 1280M by a
  watchdog`. Root starts the supervisor again 10s later and the session
  resumes its conversation. Between two checks the lead can outgrow the cap,
  so its `oom_score_adj` is also 1000, set by root so the lead cannot lower
  it: if the machine runs out first, the kernel kills the lead before the
  server. A watchdog that cannot read `/proc` logs `the lead's memory is NOT
  capped`.
- **Its network.** The lead and the dev server (which runs code the lead
  writes) connect only to loopback; their DNS is refused too. Their one way
  out is a proxy on `127.0.0.1:3128` (`lead-proxy.ts`, run as `cwproxy`),
  which opens a connection only to a host name in
  `infra/project-machine/lead-egress.allow`: the model API and Claude's
  sign-in host, `registry.npmjs.org`, and GitHub (`github.com`,
  `api.github.com`, `codeload.github.com`) on 443, and `github.com` on 22
  for the deploy key's fetches. A TLS connection must name the same host in
  its handshake as in its CONNECT. Both users get `HTTPS_PROXY`,
  `HTTP_PROXY` and `NO_PROXY` in both cases, which Claude Code, Bun's
  `fetch`, `bun install` and git over HTTPS read (each measured in a
  container on 9 November 2026; `gh` reads them too but is not in the
  image); ssh does not, so
  `lead.sh` sets git's `core.sshCommand` with a `ProxyCommand` through the
  same proxy. The rules (`lead-egress.ts`) are loaded at boot, then a probe
  as the lead must be refused by 1.1.1.1:443 and the IPv6 equivalent, fail
  to resolve `example.com`, be refused `example.com` by the proxy, and reach
  `https://api.anthropic.com` through it. The boot log says `the lead's
  network wall holds`, or `is in but UNPROVEN` when the model API did not
  answer either. When the rules cannot be loaded or the probe gets through,
  it says `the lead's network is NOT walled: <why>` and starts neither the
  lead nor the dev server. `fly secrets set CW_LEAD_EGRESS=open` runs both
  without the wall, and the log says so on every boot. Each host the proxy
  refuses is a line `[lead-proxy] refused <host>:<port>: <why>`, at most once
  a minute per host. Claude Code runs with `DISABLE_TELEMETRY=1` and
  `ENABLE_CLAUDEAI_MCP_SERVERS=false`, so it does not try the telemetry and
  connector hosts; not `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, which
  turns Remote Control off as well. A dev server or a package that needs
  another host needs a line in the list and an image deploy. What the wall
  leaves open is in [security.md](../architecture/security.md), under the
  project machine's lead.

**When it ends.** `lead.sh` checks the tmux session every 5 seconds and starts
the session again, resuming the last conversation in `/data/lead/work`
(`claude --continue`) once one exists, so a restart or a deploy keeps the
lead's context; the first boot starts fresh. It waits 5s, then 10, 20, 40 and 50s for ends
in a row, so a restart comes within a minute. After six quick ends in a row
(each under five minutes) it tries every ten minutes; a session that lasts
five minutes resets the count. Root starts `lead.sh` itself again 10s after
it exits, so a lead that kills its supervisor stops neither the server nor
the machine.

**A restart Team Lead asks for.** When `CW_LEAD_INBOX_DOC` (the lead seat's
inbox doc) and `CW_RELAY_AGENT_ID` (the agent id of the org relay's board
token) are both set, `lead.sh` runs `lead-restart.ts` every 30 seconds.
`bun run relay:install` sets both as Fly secrets on the project's app, from
the lead's seat ([Installing the org relay](#installing-the-org-relay)), and
`entrypoint.sh` passes them to the lead. Each check is cut
off after 20 seconds, and each call it makes after 10, so a board server that
hangs cannot stop the supervisor watching the session. It
reads the inbox doc's threads over the board socket and answers `restart`
only for the org relay's restart line for this lead, on a thread the relay's
token opened, under ten minutes old and not handled before
(`restart-handled.json` in the lead root, mode 600). `lead.sh` then ends the
tmux session and starts it again at once, with no backoff. Without the two
settings the check never runs. Which seats may ask is the relay config's
`restartFrom` (cross-board.md).

To look at the session (`--pty`, because tmux needs a terminal; `env -i`, so
root's secrets stay root's):

```bash
fly ssh console --pty --app cw-<project> -C \
  "env -i TERM=xterm-256color setpriv --reuid=lead --regid=lead --init-groups tmux attach -t lead"
```

Detach with `Ctrl-b d`; exiting Claude Code ends the session, and the
supervisor starts another. `fly secrets set CW_LEAD_REMOTE_CONTROL=1` starts
each session with Remote Control, named after the agent (the flag is in the
pinned Claude Code build). The daily wall report fails a machine whose lead
runs with Remote Control unless its `machines.json` entry says
`"remoteControl": true`.

### The lead's limits: checking them on a machine

The wall loads as a native nftables table, `inet cw_lead_egress`, matched by
`meta skuid`. Fly's kernel (6.12, measured 15 November) has no `xt_owner`, so
iptables' `-m owner` match fails there under both iptables-nft and
iptables-legacy; nftables' own skuid match loads and enforces. The iptables
chain is kept as the fallback for a kernel where nft fails, and the boot line
names which one loaded and, for the fallback, why nft did not.

The tests prove the rules, the proxy and the watchdog on Docker's Linux kernel
(`CW_CONTAINER_TESTS=1 bun test packages/server/test/project-machine-lead-limits-container.test.ts`),
not on Fly's. On a test machine with a lead, after a deploy:

1. `fly logs --app cw-<project> --no-tail | grep -E "lead's (memory|network)"`.
   The memory line names the cgroup or the watchdog; the network line must
   read `the lead's network wall holds`, and the `wall is in` line before it
   must say `by nft table inet cw_lead_egress`. `fly ssh console --app
   cw-<project> -C "nft list table inet cw_lead_egress"` prints the table.
2. The wall, by hand, as the lead (`env -i`, so root's secrets stay root's,
   and the proxy given the way the entrypoint gives it):
   ```bash
   fly ssh console --app cw-<project> -C "env -i PATH=/usr/local/bin:/usr/bin:/bin HTTPS_PROXY=http://127.0.0.1:3128 setpriv --reuid=lead --regid=lead --init-groups bash -c 'cd /tmp; timeout 5 bash -c \"exec 3<>/dev/tcp/1.1.1.1/443\" && echo LEAK || echo refused; f=\"try{console.log((await fetch(process.argv[1])).status)}catch{console.log(0)}\"; bun -e \"\$f\" https://example.com/; bun -e \"\$f\" https://registry.npmjs.org/is-number'"
   ```
   It must print `refused`, `403` (the proxy's refusal) and `200`. The
   first as root (without `setpriv`) prints `LEAK`, which is the control.
   `fly logs` shows `[lead-proxy] refused example.com:443`.
3. The lead's tools, once it has a checkout: attach and have it run `bun
   install` and `git fetch` in `/data/dev/work`. Then watch `fly logs` for
   `[lead-proxy] refused` lines for an hour of normal work, Remote Control
   included if it is on: each names a host something the lead runs needs,
   which is the evidence for adding a line to the list.
4. The memory cap, at its default 1280M on a 2048 MB machine. Read what the
   lead holds now (`fly ssh console --app cw-<project> -C "bash
   /app/infra/project-machine/lead-memory.sh total 10004"`, in bytes), then
   make a lead process grow by 80 MB a second:
   ```bash
   fly ssh console --app cw-<project> -C "env -i PATH=/usr/local/bin:/usr/bin:/bin setpriv --reuid=lead --regid=lead --init-groups bun -e 'const a=[];for(;;){a.push(Buffer.alloc(8<<20,1));await Bun.sleep(100)}'"
   ```
   It must be killed within about 20 seconds, and `fly logs` must show
   `killing all <n> of them` (watchdog) or the kernel's OOM kill in
   `cw-lead` (cgroup). The lead's session is killed with it and is back
   within a minute; the server must not restart (`fly logs` shows no
   `a child exited`).

## The central token list

Long-lived Claude tokens live in one list on the Mac, so a new project signs in
with no browser approval and a project can be moved between tokens to manage
usage.

**The list holds only accounts Bryan owns, never another person's** (his
answer on the board, 2026-11-07: "My own accounts"). Anthropic's terms bar
routing work through another person's account. Whether moving work between
accounts one person owns is allowed is not settled by anything published: the
text does not address it, and it bars acts that "bypass or interfere with"
product restrictions without saying whether usage limits count.

Each token is a Keychain entry `claude-token-list-<n>` holding a label, the
token and the day it was added (`infra/project-machine/token-list.ts`). Read a
label, never a value:

| Step | Command |
|---|---|
| See the list | `bun run machine:tokens list` |
| Add the account signed in to this Mac's browser | `bun run machine:tokens add --label <name>` |
| Add a token already made | `bun run machine:tokens add --label <name> --stdin` |
| Read each token's usage | `bun run machine:tokens usage [--project <name>]` |
| Show each lead's spend in budget watch | `bun run machine:tokens burn [--project <name>]... [--every 900]` |
| Move a project | `bun run machine:tokens move --project <name> --to <label>` |

- A label is a name for an account, not an address: a-z, 0-9 and `-`.
- A deploy that needs a token takes the label `machines.json` pins on the
  project (above). It sets the token and a marker
  (`listed:<label>:<sha256 of org, label and token>`) in `CW_LEAD_TOKEN_ORG`.
- **A move** is `fly secrets import` without `--stage`, which sets both and
  restarts the machine in one call. The board is down for a boot and the lead
  resumes its conversation. The move then waits until the machine reports the
  new label. That shows the machine took the token, not that Claude accepted
  it. Both calls run with the app's own token on the Mac, with no tap. Pin the
  new label in `machines.json` first: a move to any other label is refused. It refuses, before
  any change, a project with no lead or a machine on an image older than this
  code, whose entrypoint would read the marker as another org's and start no
  lead. Deploy that project first. A move off a token made for one org leaves
  that token live for up to a year, so revoke it.
- **Usage** comes from Claude Code's status line. `lead.sh` installs
  `lead-usage.ts` as the lead's status line command, which keeps
  `rate_limits` (5-hour and 7-day percentages and end times) in
  `/data/lead/usage.json`. `machine:tokens usage` reads that file as the `lead`
  user over `fly ssh console`, with each app's own token, for every project
  `machines.json` lists. It shows
  each listed token's newest reading from the projects on it now, so a token
  no project runs on has no reading. The file is the lead's to write, so a
  steered lead can misreport its own token.
- **Spend in budget watch.** Budget watch on the Mac sums the token counts in
  the transcripts under `~/.claude/projects`, one row per folder. A machine's
  lead writes its transcripts on the machine, so `machine:tokens burn` copies
  them over as counts only: `lead-turns.ts` runs as the `lead` user over `fly
  ssh console`, with the app's own token, and prints each billed request's
  time, request id, model and four token counts. The Mac checks every field
  and writes them as transcript lines under
  `~/.claude/projects/cw-machine-<project>/` (main sessions in `lead.jsonl`,
  subagents under `subagents/`), so budget watch shows a `cw-machine-<project>`
  row beside the Mac's projects with no change to budget watch. Each pull
  takes what is new since an hour before the newest turn already copied; the
  files keep eight days. `--every 900` repeats it, in a tmux session beside
  budget watch's own loop. Budget watch adds the row to its fleet total, which
  it compares with the Mac account's limit, so a lead on a token from another
  account makes that total high by the lead's share.
- **Unproven: whether `rate_limits` appears for a session signed in with
  `CLAUDE_CODE_OAUTH_TOKEN`.** The docs do not say, and give it only on Pro,
  Max and Ultra plans, after a session's first answer. The first real read
  answers it: `the status line ran on <project>, with no rate_limits so far`,
  after the lead's first answer, means it does not. The undocumented OAuth usage endpoint is not used.
- **Sharing a token gives up per-org revocation.** Every project on a listed
  token holds the same value. A lead can spend or send away its own sign-in
  (`docs/architecture/security.md`), so a token leaked from one project works
  for all of them, and revoking it stops every lead on it until each is moved.
- **Retire a token** by moving its projects off, revoking it at
  claude.ai/settings/claude-code, and removing its entry:
  `security delete-generic-password -a claude-workspaces -s claude-workspaces-secret.claude-token-list-<n>`.
  A setup token lasts a year; `machine:tokens list` shows when each runs out.

Still unchecked on a real machine: whether a `setup-token` sign-in allows
Remote Control; whether Claude Code asks anything on its first run that the
seeded `~/.claude.json` does not answer; whether `--continue` and
`--remote-control` work together; the session's memory; whether a Fly
machine's kernel loads the lead's network wall; and the MCP relay over the
board socket under the image's bun. Attach once after the first deploy and
look. The session runs in Claude Code's default permission mode, so it asks
before each tool; nobody answers unless a person attaches or uses Remote
Control.

## A dev server for review

A collaborator opens the project's dev server through the board, with the
widget on it, under the board's own sign-in. The dev server runs on the
machine and binds loopback; nothing reaches back to the Mac.

```bash
fly secrets set --app cw-<project> \
  CW_DEV_SERVER_CMD='bunx vite --host 127.0.0.1 --port 5173 --strictPort --base /workspaces/<board>/apps/<app id>/' \
  CW_FRAME_ORIGIN=https://<project>.<frame domain>
```

- **Its user.** The entrypoint runs `CW_DEV_SERVER_CMD` with bash as
  `cwdev`, in `/data/dev/work`, with `PATH` and the proxy's address and nothing else: no secret, no
  board socket, and the server refuses its loopback TCP calls as it refuses
  every uid but root's and its own. It is started again when it exits, after
  a wait that doubles from 5s to 60s; it never stops the machine.
- **Its network.** The lead's wall and its proxy, because it runs code the
  lead writes ("Its network" under the lead, above). `bunx` and `bun
  install` reach `registry.npmjs.org` through the proxy; a package that
  fetches from any other host at install time is refused, and the boot log
  names the host.
- **Its files.** `/data/dev` is `cwdev:cwdevsrc` mode 2770, and the group
  `cwdevsrc` holds `cwdev` and `lead`. The lead clones the project's repo
  into `/data/dev/work` and edits it there; the lead's umask is 007, so its
  files there are the group's and the dev server reads them. Its own folder,
  `/data/lead`, stays mode 700.
- **The address.** The lead attaches it with `attach_app(workspaceId,
  docId, "http://127.0.0.1:5173", servesPrefix: true)` and gets the prefix
  back, `/workspaces/<board>/apps/<app id>/`. That prefix is Vite's `base`,
  and the app's router takes `import.meta.env.BASE_URL` as its basename. With
  `servesPrefix` the board sends the dev server the whole path, prefix kept,
  which is what Vite started with `base` answers; without it, Vite answers
  every path with a redirect or a 404. The command is an operator setting, so
  the prefix goes into `CW_DEV_SERVER_CMD` after the first attach.
- **Who opens it.** The owner and the board's members, through the
  project's hostname and Access. Each opens a host page whose frame is on the
  frame hostname with a ticket naming them, so the app's own scripts load with
  the frame cookie; an opaque frame's subresources carry no cookie, and Access
  answers them with its sign-in page. A member's frame ends when the
  membership does. A share visitor reaches it as they reach a mock on the
  board, GET and HEAD only ([security.md](../architecture/security.md), "An
  attached dev server").
- **Not yet.** `machine:deploy` sets neither setting, and the frame
  hostname has to be routed to the machine (`FRAME_DOMAIN` in the board
  router). Vite's HMR socket is not proxied, so an edit shows on reload.
  Without `CW_FRAME_ORIGIN` the app's page and widget load and its scripts do
  not.

## Pushing a branch from the lead

The lead pushes through the server, which holds one write deploy key per
repo as the Fly secret `CW_GITHUB_PUSH_KEYS` and the board's repo list in
`/data/cw/git-push.json`. `fly-provision.yml` makes the keys for the repos
the project's entry in `infra/project-machine/machines.json` lists as
`pushRepos` (`owner/name` each). The repos are never a dispatch input, so a
repo gets a write key only through a merged change. Two projects may list
one repo only when both also name it in `sharePushRepos`; otherwise the file
is refused, because two orgs would hold a key that writes to it. Dispatch the workflow
after that change lands, with `refresh_push_keys` to replace keys the app
already has.

For each repo the `fly-org` job makes a key pair in memory, registers the
public half on that repo as a write deploy key with `GH_ADMIN_TOKEN` (a
classic token with `repo` scope), and sets the private halves on the app.
Its log names each repo and the Actions secret names a workflow pushed with
the key could read. The keys are made once; `refresh_push_keys` makes new
ones and removes the older keys for the app. A deploy
key reaches its one repo, so the machine can push nowhere else. The deploy
also unsets `CW_GITHUB_PUSH_TOKEN` if the app still has one: a project
machine holds no classic token. The request and the file are in
[lead-sandbox.md](lead-sandbox.md), "A lead pushes through its board server".

## Installing the org relay

The org relay carries messages between the leads' seats
([cross-board.md](../architecture/cross-board.md)). It runs on the Mac.
`bun run relay:install` installs it, or brings an install up to date, for the
seats in `infra/org-relay/seats.json`. That file names each seat by its role
and never by a board or doc id. A Mac seat names its agent id. A project seat
names its project in `machines.json`, and its agent is that project's lead
(`<project>-lead`, or the seat's `agentName`). Run it with `--dry-run` first.
The dry run prints the plan with every token value redacted, and it writes,
mints and files nothing. It does read each server, over `fly ssh console` for
a project machine.

The script does these steps in order:

1. **It finds each seat's board, tasks and token.** The board is the one
   board on the seat's server whose lead is the seat's agent. If there is not
   exactly one, the script stops and asks for `--board <seat>=<board id>`.
   The seat's outbox and inbox are the tasks "Relay outbox: <seat>" and
   "Relay inbox: <seat>". The script files each one if it is missing. Then it
   mints the relay's `at2` (agent `relayAgentId`) on each board through
   `/api/board-tokens`. On the Mac it calls the server's loopback directly. On
   a project machine it runs curl on the machine's loopback, as `cw`, over
   `fly ssh console`, the same way as the push-key step below. If the
   installed config already holds a token whose record is live, the script
   keeps it. **`--remint` mints a new token, which replaces the old one.**
   The script revokes the old record only after the relay has restarted on
   the new config.
2. **It writes the config.** The file is
   `~/Library/Application Support/claude-workspaces/relay/relay-config.json`,
   at mode 600, in the shape `relay-config.ts` reads. The script checks the
   config with that parser before it writes. A server's address is the
   project's router host from the Terraform outputs. A server with Access in
   front needs its seat to name `accessToken`, the Cloudflare service token's
   name. The script reads the token's client id and secret from the Keychain
   under `tokenServices` names. No token value goes into an argument, onto
   stdout or into a log.
3. **It writes and loads the LaunchAgent.** The agent is
   `~/Library/LaunchAgents/com.fryanpan.claude-workspaces-relay.plist`. It
   runs `relay-bin.ts` from prod's checkout with prod's bun, with
   `CW_RELAY_CONFIG` and `CW_RELAY_STATE_DIR` (`relay/state`) set, and
   writes its log to `relay/relay.log`. If the plist changed, the script
   loads it again. If it did not, the script restarts the relay with
   `kickstart -k`.
4. **It sets the lead's two settings.** It sets `CW_LEAD_INBOX_DOC` and
   `CW_RELAY_AGENT_ID` with `fly secrets import`, values on stdin, on each
   project app whose lead is a seat. **This restarts that machine.** So the
   script records what it set in `relay/installed.json` and skips an app
   whose values have not changed.
5. **It checks the result.** The relay must log `running: N seats` after this
   start, and every seat's server must answer the relay's own read of the
   seat's outbox. If either check fails, the script exits 1.

Run the script again whenever `seats.json` changes. A second run with nothing
changed mints nothing, files nothing and sets no secret. It does restart the
relay.

The relay runs as the Mac's own user, so any process of that user can read
its config. The separate macOS user that
[security.md](../architecture/security.md) asks for is not installed yet.

## GitHub events for a board here

A board on this machine holds no GitHub token. It keeps a list of the events
it wants, and the GitHub relay on the Mac reads that list and pushes each
matching event, which reaches the board's agents as a `workspace.github_event`
line. The design is in
[security.md](../architecture/security.md) ("A board on another server hears
GitHub"). Adding a board takes five steps; the first two run on the machine,
the rest on the Mac.

1. **Mint the board's push key and put it in the Mac's Keychain.** The key is
   printed once and never stored on the machine. Keep it out of the terminal
   and out of any argument list:

   ```bash
   KEY=$(fly ssh console --app cw-<project> -C \
     "curl -s -H 'host: localhost:8787' -H 'content-type: application/json' \
       -d '{\"workspaceId\":\"<board id>\"}' http://127.0.0.1:8787/api/github-push-keys" \
     | tail -1 | jq -r .key)
   printf 'add-generic-password -U -a %s -s cw-<project>-github-push -w %s\n' "$USER" "$KEY" | security -i
   unset KEY
   ```

   Minting again replaces the key, and the old one stops working at once.

2. **Subscribe the board.** An agent on the machine calls
   `set_github_subscriptions`; from the Mac, the same PUT over `fly ssh`:

   ```bash
   fly ssh console --app cw-<project> -C \
     "curl -s -X PUT -H 'host: localhost:8787' -H 'content-type: application/json' \
       -d '{\"subscriptions\":[{\"repo\":\"<owner>/<repo>\",\"kinds\":[\"ci\",\"review\",\"mention\",\"merge\"]}]}' \
       http://127.0.0.1:8787/workspaces/<board id>/github-subscriptions"
   ```

   Spell the repo as GitHub does: the broker matches it exactly. The relay
   rereads the list once a minute.

3. **Give the relay the board's Access service token.** The relay calls the
   board at its project address, through Access, with the same service token
   Home across servers uses, so the server's `CW_HOME_FEED_CLIENT_ID` must
   already name it. Put the token's secret in the Keychain as
   `cw-<project>-access-secret` the same way as step 1.

4. **Add the board to the relay's config**, `.claude/github-relay.local.json`
   at the root of the checkout the relay runs from (gitignored, mode 600):

   ```json
   {"broker": "http://127.0.0.1:7902",
    "boards": {"<project>": {
      "baseUrl": "https://<project>-workspaces.<zone>",
      "workspaceId": "<board id>",
      "pushKeyService": "cw-<project>-github-push",
      "serviceToken": {"clientId": "<client id>.access", "secretService": "cw-<project>-access-secret"},
      "repos": ["<owner>/<repo>"]}}}
   ```

   `repos` lists the only repos this board may hear, and it is required. The
   board's own subscription list is written on the machine, so the relay
   watches only the subscriptions this list also names; any other is logged
   by name and never watched. Name only the org's own repos here.

5. **Restart the relay** so it reads the Keychain again:
   `bun packages/server/src/github-relay/relay-bin.ts`. It logs
   `<project>: registered, watching N repo(s)` once the board answers. It
   registers again by itself when the broker restarts, so the broker never
   needs to know about it.

## Moving a board onto the machine

```bash
bun run machine:move-board --board <id> --project <project> [--dry-run]
    [--source-data-dir <dir>] [--source-url http://127.0.0.1:8787] [--sync-config <path>]
```

Run on the Mac, after `machine:deploy` has put this commit's image on the
machine (the importer, `board-probe.ts`, ships in the image). Its `fly ssh`
and `fly ssh sftp` calls run with the app's own token, with no tap. It keeps every
id, so `/workspaces/<id>/…` links work once the router sends the board to the
machine. In order:

1. Fingerprints the board on the Mac's server: each doc's text, every thread
   and comment on its docs and rows, its tasks, and the lines of its event and
   agent-note logs (`board-print.ts`). A doc in the board's `docIds` whose
   content and threads both answer 404 is a dangling id: it is fingerprinted
   as missing, the export carries the id with no files, and the line
   `source:` says how many there are. A doc whose content answers 404 while
   its threads answer stops the move.
2. Stops, changing nothing, if the machine already holds the board.
3. Exports it (`board-bundle.ts`) and fingerprints the source again. If the
   board changed while it was read, it stops: quiet the board's agents first.
4. Copies the bundle into a root-only directory on the machine, holds the
   machine's services off with `/data/maintenance`, imports, and restarts.
   The import refuses, having written nothing, when the data dir already has
   any of the board's files or an entry for it in a shared file. It reads the
   bundle as hostile and also refuses a symlink or an unlisted file, a doc or
   board record that names a path, and a shared-file entry for any other
   board. Imported or refused, the upload is removed and the services start
   again.
5. Fingerprints the board on the machine, then the Mac's board once more.
   Only when the machine matches and the Mac has not changed since step 1
   does it archive the Mac's board (`PUT /workspaces/<id>/retired`), which is
   reversible. It never deletes anything on the Mac.

`--dry-run` stops after step 3 and prints what would move.

**What moves.** `workspaces/<board>.*` (the board record with its tasks, goal
rows and review items, the event and agent-note logs, the comment and voice
queues, the home brief, the load reports); the docs `ws:<board>`,
`task:<id>` for every row, and every doc in the board's `docIds`, each with
its `.ydoc`, voice-feedback log and recordings, meetings folder and huddle
notes; and the board's entries in seven shared files: share links, members
and audience (`share-links.json`), Access shares (`shares.json`), the close and
lock flags (`sharing.json`), lead ranks (`review-ranks.json`), the board
summary, dispatch reports and the review-answer log.

**What stays on the Mac.** Paths on the Mac never leave it: each doc's
`.private.json` (its bound file, among others), the board's `notesHome`, and
any of those keys an old `.ydoc` still carries. The bound files come back as
`bindings`, for the sync below. Also left: `.attachments.json` (the agent
sessions attached now; they attach again on the machine), `.index.json`
(rebuilt at boot), board agent tokens, GitHub push keys and thread-opener
proofs (minted by the Mac's server and meaningless to another), stall and
nudge stamps (rebuilt), the owner's analytics logs, and archived docs.

After a move the board's agent needs a board agent token minted on the
machine, and its GitHub events need the five steps above, run for the
machine.

To reach the moved board, the agent's session also needs the project's Access
service token. Launch it with `CW_BASE_URL` set to the machine's URL,
`CW_ACCESS_CLIENT_ID` set to the token's client id, and
`CW_ACCESS_SECRET_SERVICE` set to the Keychain service that holds its secret.
The MCP child and the plugin's hooks then send both `cf-access-client-*`
headers on their requests to that URL's origin, and to no other. The launcher
uses the node relay, because the compiled relay cannot read Keychain.

### Without `fly ssh`: `machine:push-board`

```bash
bun run machine:push-board --board <id> --project <project> [--dry-run]
    [--target-url https://<project host>] [--token "agent <project>"]
    [--source-data-dir <dir>] [--source-url http://127.0.0.1:8787]
```

Run on the Mac. It takes the same steps as `machine:move-board`, in the same
order, with the same checks. Only the transport is different: it uses no
`fly ssh`.

1. The bundle goes over HTTPS to the project's own hostname, which the board
   router sends to the project's machine. The request is
   `PUT /api/board-import/<id>` (`packages/server/src/routes/board-import.ts`),
   and it carries the project's existing Access service token. That is the
   token named `agent <project>` in `access.local.json`, read from the
   Keychain where `cf:sync-config` stored it. The push mints nothing.
2. The machine checks the push the same way `machine:move-board` checks an
   upload (`board-import-store.ts`, then `readBundle`). It stages the push
   under `/data/board-imports/<id>/` and restarts.
3. The boot imports the push as `cw`, before the server starts
   (`board-import-cli.ts apply`, from `entrypoint.sh`).
4. The Mac polls `GET /api/board-import/<id>` until the import is recorded.
   It then compares fingerprints (`POST /api/board-import/<id>/print`) and
   archives its own board, which is reversible.

**What the machine accepts.**

- **Only the board its lead leads.** `CW_LEAD_BOARD` becomes
  `CW_BOARD_IMPORT_BOARDS`. A machine without a lead board accepts none.
- **Only a request through the tunnel.** It must carry `cf-ray` and a stamp
  signed for the Access application in front of the host. The stamp must name
  no email and must carry a service token's `common_name`. Set
  `CW_BOARD_IMPORT_CLIENT_ID` to also require one particular client id.
- **Never a board it already holds or has already staged.** `importBoard` also
  refuses to write over any file. So a second push or a second boot never
  overwrites edits made on the machine after the move.
- **Never the Mac paths a doc was bound to.** These are sent nowhere, and
  `--sync-config` is not offered here.

**Reading the result.** The status of each push is in
`/data/board-imports/<id>/status.json`: `staged`, `importing`, `imported` or
`refused`, with the reason.

## Bound files after the move

On the Mac a doc can be bound to a `.md` in a repo, and the server keeps the
two in step. The machine cannot reach that repo. `machine:sync-board` holds
the binding from the Mac instead: one process per board, which joins each
doc's editing socket as a co-editor does, writes the file when the doc
changes, and applies the file to the doc when the file changes, with the
server's own serializer and block diff, so threads on untouched blocks keep
their anchors.

- **Delay.** A remote edit reaches the file 800ms after it arrives (the
  server's own write-back debounce). A file edit is seen within 1s and sent at
  once. With the network, about 2 seconds each way.
- **Restarts.** It records what it last wrote. At start, if only the file
  changed, the file wins; otherwise the doc wins, and a file it replaces is
  copied to `<state dir>/replaced/` first.
- **Edits from the file read as a person's.** They arrive over the editing
  socket, so the server's stale-write guard makes an agent re-read before a
  REST edit replaces them.
- **Off by default, per board.** `--sync-config <path>` writes a config with
  `"enabled": false`; it runs only after a person sets it to true. It is
  refused when group or others can write it, since it names the files the
  sync writes.

It reaches the board the way the relay does, with two credentials: the
project's Access service token, and a board agent token for the one board.
Mint the token on the machine and keep it out of the terminal:

```bash
TOKEN=$(fly ssh console --app cw-<project> -C \
  "curl -s -H 'host: localhost:8787' -H 'content-type: application/json' \
    -d '{\"agentId\":\"<project>-board-sync\",\"boardId\":\"<board id>\",\"label\":\"board sync\"}' \
    http://127.0.0.1:8787/api/board-tokens" | tail -1 | jq -r .token)
printf 'add-generic-password -U -a %s -s cw-<project>-board-sync-token -w %s\n' "$USER" "$TOKEN" | security -i
unset TOKEN
bun run machine:sync-board <config path>
```

It renews the token itself every 12 hours and keeps the renewed value in its
state dir (`CW_BOARD_SYNC_STATE_DIR`, default
`~/.claude/claude-workspaces/board-sync`, mode 700). Revoking the token on the
machine stops it.

## The transcript store

Every machine sends its session transcripts and analytics events to one
Tigris bucket, `cw-transcript-store`, within about two minutes of each line
being written. Each chunk is compressed and sealed to the review key; a
private or local-only board's chunks are sealed as well to that board's key,
or to the owner key while the board has none. The machine holds only
public keys (`STORE_KEYS`), so it cannot read back what it sent. The Mac reads
the store with `bun run store:read`.

**Who makes what.** The first `fly-provision.yml` run, for any project, makes
the bucket with versioning on, the review, owner and usage key pairs, and the
Mac's read-and-list credential; each identity and credential is sealed to the
Mac and stored on `handoff:pull`. The run also writes the bucket's admin
credential to the `fly-org` environment as the secret `STORE_BUCKET_ADMIN`, and
the public keys as the variable `STORE_KEYS`, so later runs find the store
made. Every run then mints the machine a writer, a credential that may put
objects under `<app>/` and `<app>_lead/` and nothing else, and sets it as the
app's secrets. The writer is kept nowhere else. To replace one, unset
`STORE_S3_ACCESS_KEY_ID` on the app and dispatch the workflow again. A
`machine:deploy` from the Mac makes none of this.

**Who reads what on the machine.** Claude Code writes every transcript mode
600, so only its owner can read it, and a user's processes can read each
other's environment, so neither owner may hold the writer. The entrypoint
runs three processes, the way the backup splits into `cw` and `cwbackup`:

| Process | User | Reads | Holds |
| --- | --- | --- | --- |
| `store-uploader.ts` | `cw` | `/data/claude-projects`, the data dir's event logs | public keys only |
| `store-uploader.ts` | `lead` | `/data/lead/claude-projects` | public keys only |
| `store-sender.ts` | `cwstore` | the two spools | the writer, nothing else |

Each reader writes its sealed chunks into its own spool, `/data/store-spool-cw`
or `/data/store-spool-lead`, which is `cwstore:<reader>` mode 3770: the reader
may add files and remove only its own, and no other user can enter.
The sender puts each file under the key its name stands for and then removes
it. It refuses, and leaves in place, a link, a file with a second name, one
the reader does not own, one over 64 MiB, and one whose key is not under that
reader's host, so a reader cannot get the sender to upload its credential or
to write under the other host. A reader holds, and logs, a chunk the sender
would refuse rather than count it sent. The sender sends chunks before the
manifests that list them, and one spool's failed put does not stop the other.

**Checking it.** `bun run store:read list --host cw-<project>` counts the
objects under both hosts and opens one transcript and one event chunk,
printing keys, sizes, line counts and a hash, never content.
`bun run store:read check --hosts cw-<project>` opens every chunk of a day
and raises any fault to Sentry (`store-check.ts`).

## Restore

```bash
bun run machine:restore --project <project> [--snapshot <key>]
```

It downloads the newest snapshot (or the named one) with the admin
credential, decrypts it on the Mac, so the identity never goes near the
machine, and copies the result up. On the machine it holds the services off
with `/data/maintenance`, moves the current data dir and transcripts dir to
`<dir>.before-restore-<time>` (never deletes them), unpacks the restore in
their place and restarts.

The restored data is the newest snapshot, up to six hours old. Anything
written after it is in `/data/cw.before-restore-<time>`.

## The restore drill

```bash
bun run machine:drill --project <name>-test
```

Run it once before any outsider gets a link, then after any change to
`infra/project-machine/`. It refuses a project whose name does not end in
`-test`, because it destroys the volume. It seeds a board named "Riverbend
drill" (refusing a server that holds any other board) with two fixture docs,
a task, which writes the board's event log, an agent note and a session
transcript. It counts and hashes the docs, the events, the notes and the
transcripts, backs up with the machine's own credential, destroys the
machine and the volume, deploys again, restores, and counts and hashes again.
The logs are compared on the lines the backup held, since a running server
may append to them. It prints `PASS` only when all four match and none was
empty.

## Checking the walls

Two checks show that one project cannot reach another. Both print a table
and exit 1 unless every row passes, and both take `--dry-run`, which prints
what they would run and runs nothing.

### The network wall

```bash
bun run machine:network-wall --dry-run
bun run machine:network-wall [--region sjc]
```

This shows two Fly private networks unable to reach each other. It makes
three throwaway apps, each with one `shared-cpu-1x` machine of 256 MB running
a small listener on port 8797:

| App | Network |
| --- | --- |
| `cw-walltest-harborlight` | `cw-walltest-harborlight` |
| `cw-walltest-riverbend` | `cw-walltest-riverbend` |
| `cw-walltest-harborlight-peer` | `cw-walltest-harborlight` |

The first two are set up the way `machine:deploy` sets up two projects. Each
machine probes the other in both directions, by `<app>.internal` and by 6PN
address, and every probe must be refused, time out or fail to resolve. The
control runs first: each machine reaches its own listener, and the peer, a
second app on Harborlight's network, reaches Harborlight by name and by
address. A failed control fails the run before any wall probe is read, so a
probe that cannot connect to anything cannot pass as a wall holding. A
listener answers with a banner, so a probe counts as connected only when it
reached this check's own listener.

Every app the run made is destroyed at the end, also when a step fails. If
apps from an earlier run still exist, it refuses to start and names the
`fly apps destroy` commands; it does not destroy apps it did not make. A
destroy that fails also fails the run, and the run names what is left.
`fly` runs with the org token the way `machine:deploy` runs it. A dry run
reads neither the token nor the org.

### The daily wall report

```bash
bun run machine:wall-report [--projects a,b] [--no-drift] [--dry-run]
```

The daily prod check runs this. It reports three things.

**Cross-project refusals**, in the terms of
`packages/server/test/cross-server-walls.test.ts`. On each project machine,
`wall-probe.ts mint` signs one value of each signed type that has an expiry
(`wt2`, `ft1`, `fc1`, the app voice token) with that server's key. Then
every machine gives its verdict on every machine's values. The control is
the issuing server accepting its own values. Every other server must refuse
each one with `bad_signature`, which means its key differs. Each value
expired an hour before it was made and names a board, doc and person that do
not exist, so nothing carried between machines is a credential. Each value
is checked at a time inside its window, so the signature check is the only
check it reaches. The types that never expire (`at1`, `at2`, `gp1`, `vk1`,
the session cookie) are not minted, because a minted one would be a live
credential. Their keys are derived from the same key file. The probe reads
the key file and never writes it.

**Cloudflare's config**, per project, from `terraform output` (read in
CI with the state bucket's read-only key, below). Each project must have
its own Access application with an audience no other project has, and hosts no other project's
application lists. Its tunnel must be `cw-<project>` with its own origin, and
the tunnel's public host must be one its own application gates. Its board
router route must point at a host its own application gates. The Access
team domain must be set. Audiences are compared and never printed.

**Drift**, because `machine:deploy` never sets a secret that already exists,
so a hand-set value would otherwise go unnoticed. The report flags drift and
changes nothing. Per machine:

| Check | Passes when | Read from |
| --- | --- | --- |
| Fly network | the app `cw-<project>` is on the network of that name, and no other app is on it, listed project or not | `fly apps list`, read in CI |
| No public address, no Fly service | the app holds no public IP and no machine publishes a service | `fly ips list`, `fly machine list` |
| Admission settings | each setting `settings.ts` names matches what the deploy would set now | the server's environment, through `wall-probe.ts machine` |
| Trusted emails | `CW_PROXIED_TRUSTED_EMAILS` is unset or holds the owner alone | the same |
| Loopback uid policy | the lead's uid is refused and `CW_LOOPBACK_SKIPS_ACCESS` is `1`; the users it still admits are listed | the same, and `/etc/passwd` |
| `git-push.json` | it parses; each repo is listed with whether every push waits (a `.github/` change always does) | the file on the volume |
| Push repo is this project's alone | no other machine's `git-push.json` names the same repo, unless every project naming it lists it in `sharePushRepos` | the same file on each machine, and `machines.json` |
| Deploy key | the lead's key is read-only on GitHub | its public half, matched against `gh api repos/<repo>/keys` for each repo the lead clones or may push to |
| Tunnel ingress | cloudflared runs the named tunnel, whose ingress sends the project's host to the server and everything else to a 404 | Cloudflare's API |

Per project it also checks two things off the machine:

| Check | Passes when | Read from |
| --- | --- | --- |
| `fly-<project>` environment | the GitHub Environment exists, admits `main` alone, and holds a `FLY_DEPLOY_TOKEN` updated in the last 45 days | `gh api` on the repository's environments |
| Live Access policies | the project's Access application admits only the emails, domains and service tokens `access.local.json` lists, with no bypass and no `everyone` | Cloudflare's API |

Across the account it checks four more things. No secret in the repository
or any environment other than `fly-org` is named `FLY_API_TOKEN`: CI deploys with one
token per app (`bun run fly:ci-tokens apply`, `infra/cloudflare/README.md`
"Fly's CI tokens"), and the org token stays in `fly-org`. The staging app's
environment, `fly-appkit-staging`, gets the same row as a project's. When
the router config has more than one origin, `ONE_ADDRESS_ORIGIN` must be set to one of them. No
service token may be admitted by two projects' Access applications. A
Cloudflare plan in CI mode (no lock, nothing applied) must have no changes,
which shows that the live Access applications and policies, the tunnel
configurations and the router Worker's bindings match the config. The
probe's output carries addresses, hostnames, audiences and uids and no
secret, and the report prints only whether each one matches. `--no-drift`
leaves this part out.

It runs on the Mac, which holds no Cloudflare token and not the Fly org
token. Two reads need one, so CI makes them: `.github/workflows/wall-read.yml`
runs every day and on a dispatch from main.

- **Cloudflare.** A job in `cloudflare-prod`, with the token and state
  key cloudflare.yml's apply uses, reads prod's Terraform outputs, each tunnel's configuration, the
  live Access applications and service token names, and a plan in CI mode.
- **`fly apps list`.** A job in `fly-org-read` reads each project app's name
  and network with `FLY_READ_TOKEN`, which reads every app and the org and
  can change nothing: no deploy, no machine control and no WireGuard, so no
  `fly ssh`. `fly-ci-tokens.yml` cuts it from the org token every week for
  14 days, so the daily job never holds the org token.

Each job seals what it read to the Mac's handoff key (`infra/handoff/`),
because the artifacts of a public repository are public, and uploads it as
`wall-read-cloudflare` or `wall-read-fly`. The report downloads the newest
run's artifacts with your `gh` login and opens them with the handoff key
(`wall-read-pull.ts`). It reads only runs on main that a schedule, a push or
a dispatch started. Each read gets a row that names its run and fails when
the read is over 36 hours old or missing; to make a new one, run
`gh workflow run wall-read.yml --ref main`. The read is prod's, so the
report has no `--tf-env staging`.

Everything else runs on the Mac. `fly ips list`, `fly machine list` and
`fly ssh` use each app's own token (`mac-ops.ts`). The deploy-key and GitHub
Environment reads use your `gh` login. The admission settings compare
against the Terraform outputs and the owner's address, and that address is
the one Keychain entry the report reads.

The projects are `--projects`, or else every project the outputs give a
tunnel. With fewer than two project machines there is no pair to compare,
and the report fails and says so. It reaches each machine over
`fly ssh console`, so a machine must run an image built from a commit that
has `wall-probe.ts`.

## Cost

By Fly's price list (October 2026, cheapest regions; `sjc` may cost a little
more), a `shared-cpu-1x` machine with 512 MB is $3.69 a month running all
the time and a volume $0.15 per GB-month, attached or not. Tigris bills
storage at its own list price; the drill board's snapshot, transcripts included, was 10 KB. The remote
builder Fly creates on the first deploy stops itself when idle.
