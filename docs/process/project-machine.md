# A project machine on Fly

One client project's board server runs on a Fly Machine of its own, reached
only through a Cloudflare Tunnel the machine dials out to, with its data dir
backed up, encrypted, to a bucket of the project's own. Every step is a
script an agent runs from the Mac; the files are in `infra/project-machine/`.
`<project>` below is a short lower-case name, used for every resource.

## What is on the machine

| Part | What it does |
| --- | --- |
| `Dockerfile` | The board server and both browser bundles, cloudflared, Claude Code (pinned by version and sha512), tmux and an SSH client, and six users: `cw` for the server, `cwtunnel` for cloudflared, `cwbackup` for the backup upload, `lead` for the lead agent, `cwdev` for the project's dev server, `cwrelease` for the release check |
| `fly.toml` | One machine, one volume at `/data`, no public service ports. `deploy.ts` writes the app name and size in at deploy time |
| `entrypoint.sh` | Stays root and starts the server on `127.0.0.1:8787` as `cw`, the tunnel as `cwtunnel`, the lead agent's supervisor as `lead`, the project's dev server as `cwdev` when one is configured, a loopback health check, the backup loop and the release check as `cwrelease`; if any stops, the machine exits and Fly restarts it. Each child gets only its own secrets, so no child's user can read another's |
| `lead.sh` | Keeps one Claude Code session running in a tmux session named `lead`, and starts it again when it ends (below) |
| `github-known-hosts.txt` | GitHub's SSH host keys, installed as `/etc/ssh/ssh_known_hosts` for the lead's git |
| `backup-once.sh`, `backup.ts` | Tars the data dir and the agents' session transcripts and encrypts them to the project's public key as `cw`, then PUTs the file to the bucket as `cwbackup`. Every 6 hours, the first an hour after boot |
| `release-cli.ts`, `release-store.ts`, `release-manifest.ts` | Checks for a newer signed release, chooses which app the server boots, and rolls a release back that did not stay up ("Releases", below) |
| `restore.ts` | Decrypts a downloaded snapshot onto a data dir (and a transcripts dir) that is missing or empty. Refuses anything else |

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

- `flyctl` (`brew install flyctl`). No `fly auth login`: the scripts read the
  shared org's token from the Keychain (`fly-org-token`, `fly-org-slug`) into
  each `fly` command's environment.
- For a named tunnel, a `cloudflare-api-token` Keychain entry, and the board
  router's `router.local.json` (`infra/board-router-worker/README.md`,
  "Deploying"), which names the zone and the one address. Without them the
  deploy takes `--tunnel quick` only (below).

## Deploy

```bash
bun run machine:deploy --project <project> [--memory 512] [--volume-gb 1] [--region sjc]
    [--tunnel quick|named] [--tf-env prod|staging] [--dry-run]
```

It reads what exists and does only what is missing:

1. The app `cw-<project>` in the shared org, on a private network of the same
   name, so no other project's machine can reach it.
2. The volume `cw_data`.
3. The backup key pair. The identity goes into the Keychain and is never
   replaced: a new one would orphan every snapshot.
4. The Tigris bucket `cw-<project>-backups`. Its admin credential goes into
   the Keychain as `cw-<project>-bucket-admin`; the machine never gets it.
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
| `CW_PUBLIC_BASE_URL` | `https://` and the project's first Access host |
| `CF_ACCESS_TEAM_DOMAIN` | the account's Access organization (`auth_domain`) |
| `CF_ACCESS_AUD` | the Access application `board <project>` |
| `CF_ACCESS_HOST_AUDS` | each of the project's hosts, to that audience |
| `CW_PROXIED_TRUSTED_HOSTS` | the project's hosts |

Every row but the first comes from the Terraform outputs
(`infra/cloudflare/outputs.ts`, `terraform output` against the prod state, or
the environment `--tf-env` names), so deploy reads no Cloudflare API for
them; it needs the state bucket's credential (`cloudflare-r2-tfstate` in the Keychain,
or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`). A project with no Access
application in the state yet (`bun run cf:apply` makes it) gets only the
owner address, and the run says which settings it left unset; it does not
fail. Nor does a state it cannot read: it says why and skips the same rows.

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
main or `bun run cf:apply`) makes the tunnel, for every project in `router.local.json` whose origin is
`<project>-origin.<zone>`. So the order is: add
`"<project>": "<project>-origin.<zone>"` to the router's `projects`, run
`bun run cf:plan`, read it, run `bun run cf:apply`, then `machine:deploy
--tunnel named`. The apply makes:

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
asks for it, it reads the token from Cloudflare's API
(`cfd_tunnel/<id>/token`, with the Keychain's `cloudflare-api-token`, or
`CLOUDFLARE_API_TOKEN` when set) and sets it through `fly secrets import` on
stdin. The token is never in the Terraform state, and the keeper refuses
this read, because its answer is a credential. A tunnel Terraform remade has a new token: pass
`--refresh-tunnel-token` to set it again. A machine that ran a quick tunnel
loses its `CW_TUNNEL_MODE` secret, so it starts the named one.

### Releases: how new code reaches a machine

CI holds no credential for any machine. It publishes a signed release for
every commit on main that CI passed, and each machine installs it itself.
An image change (the Dockerfile, Bun, `bun.lock`, the release key,
`entrypoint.sh`) is still `machine:deploy`, run from the keeper.

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
through a PR, and run `machine:deploy` from the keeper once for each machine,
so each image carries the key. Rotating the key is the same steps.

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
  exact token (`entrypoint.sh`). So a token set by hand, or the one every lead
  used to share, starts no lead. The next deploy on the Mac sees no
  `CW_LEAD_TOKEN_ORG` and sets a listed token, or asks for the org's approval.
- The Mac's walled lead keeps its own Keychain sign-in,
  `claude-lead-oauth-token` (`scripts/lead-sandbox-token.ts`); no org's lead
  is given it. `--claude-account` is gone.
- Revoke one org's sign-in at claude.ai/settings/claude-code; no other org
  loses its lead. `--refresh-lead` then makes the org a new one.
- `--claude-token <label>` picks a listed token and sets it again on a run
  that names it. Without it a deploy that needs a token takes the first listed.
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
- **Its files.** Its working folder is `/data/lead/work` and its transcripts
  are in `/data/lead/claude-projects`, both on the volume. `/data/lead` is
  `lead` mode 700, so the server cannot read it, and no doc can be bound to a
  file there. A folder bind over the socket is refused
  (`board-socket-lead-binds.test.ts`). The lead can still write `/tmp`, which
  the server can read, so a person must not bind a doc or folder under `/tmp`
  on this machine. The transcripts are not in the snapshots yet: the snapshot
  runs as `cw`.
- **Its memory.** The entrypoint puts the lead in a cgroup v2 group of its own
  (`cw-lead`, `memory.max` 1280M unless `CW_LEAD_MEMORY_MAX` is set), so a
  lead that grows is killed alone and the server keeps running. A machine
  with no cgroup v2 memory controller logs `the lead's memory is NOT capped`.

**When it ends.** `lead.sh` checks the tmux session every 5 seconds and starts
the session again, resuming the last conversation in `/data/lead/work`
(`claude --continue`) once one exists, so a restart or a deploy keeps the
lead's context; the first boot starts fresh. It waits 5s, then 10, 20, 40 and 50s for ends
in a row, so a restart comes within a minute. After six quick ends in a row
(each under five minutes) it tries every ten minutes; a session that lasts
five minutes resets the count. Root starts `lead.sh` itself again 10s after
it exits, so a lead that kills its supervisor stops neither the server nor
the machine.

To look at the session (`--pty`, because tmux needs a terminal; `env -i`, so
root's secrets stay root's):

```bash
fly ssh console --pty --app cw-<project> -C \
  "env -i TERM=xterm-256color setpriv --reuid=lead --regid=lead --init-groups tmux attach -t lead"
```

Detach with `Ctrl-b d`; exiting Claude Code ends the session, and the
supervisor starts another. `fly secrets set CW_LEAD_REMOTE_CONTROL=1` starts
each session with Remote Control, named after the agent (the flag is in the
pinned Claude Code build).

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
| Move a project | `bun run machine:tokens move --project <name> --to <label>` |

- A label is a name for an account, not an address: a-z, 0-9 and `-`.
- A deploy that needs a token takes the first listed one, or the label
  `--claude-token` names. It sets the token and a marker
  (`listed:<label>:<sha256 of org, label and token>`) in `CW_LEAD_TOKEN_ORG`.
- **A move** is `fly secrets import` without `--stage`, which sets both and
  restarts the machine in one call. The board is down for a boot and the lead
  resumes its conversation. The move then waits until the machine reports the
  new label. Through the keeper that is two taps: the import and the
  `fly ssh console`. It refuses, before any change, a project with no lead or a
  machine on an image older than this code, whose entrypoint would read the
  marker as another org's and start no lead. Deploy that project first.
- **Usage** comes from Claude Code's status line. `lead.sh` installs
  `lead-usage.ts` as the lead's status line command, which keeps
  `rate_limits` (5-hour and 7-day percentages and end times) in
  `/data/lead/usage.json`. `machine:tokens usage` reads that file as the `lead`
  user over `fly ssh console`, one tap per project through the keeper. It shows
  each listed token's newest reading and the projects on it.
- **Unproven: whether `rate_limits` appears for a session signed in with
  `CLAUDE_CODE_OAUTH_TOKEN`.** The docs do not say, and give it only on Pro,
  Max and Ultra plans, after a session's first answer. The first real read
  answers it: `the status line ran on <project>, with no rate_limits` means it
  does not. The undocumented OAuth usage endpoint is not used.
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
machine offers the cgroup memory controller; and the MCP relay over the
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
  `cwdev`, in `/data/dev/work`, with `PATH` and nothing else: no secret, no
  board socket, and the server refuses its loopback TCP calls as it refuses
  every uid but root's and its own. It is started again when it exits, after
  a wait that doubles from 5s to 60s; it never stops the machine.
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
`/data/cw/git-push.json`. The keeper makes the keys:

```bash
bun run machine:deploy --project <project> \
  --push-repo <owner/name> [--push-repo <owner/other>] [--refresh-push-keys]
```

For each repo the keeper makes a key pair, registers the public half on
that repo as a write deploy key with the GitHub token in its store, and sets
the private halves on the app. It waits for your passkey and lists every
repo on the approval page. The keys are made once; `--refresh-push-keys`
makes new ones and removes the keeper's older keys for the app. A deploy
key reaches its one repo, so the machine can push nowhere else. The deploy
also unsets `CW_GITHUB_PUSH_TOKEN` if the app still has one: a project
machine holds no classic token. The keeper needs the token once, from you:
[keeper.md](keeper.md), "The GitHub token". The request and the file are in
[lead-sandbox.md](lead-sandbox.md), "A lead pushes through its board server".

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
machine (the importer, `board-probe.ts`, ships in the image). It keeps every
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
bun run machine:wall-report [--projects a,b] [--tf-env prod|staging] [--no-drift] [--dry-run]
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

**Cloudflare's config**, per project, from `terraform output` (the state
bucket's credential only). Each project must have its own Access application
with an audience no other project has, and hosts no other project's
application lists. Its tunnel must be `cw-<project>` with its own origin, and
the tunnel's public host must be one its own application gates. Its board
router route must point at a host its own application gates. The Access
team domain must be set. Audiences are compared and never printed.

**Drift**, because `machine:deploy` never sets a secret that already exists,
so a hand-set value would otherwise go unnoticed. The report flags drift and
changes nothing. Per machine:

| Check | Passes when | Read from |
| --- | --- | --- |
| Fly network | the app `cw-<project>` is on the network of that name, and no other project shares it | `fly apps list` |
| No public address, no Fly service | the app holds no public IP and no machine publishes a service | `fly ips list`, `fly machine list` |
| Admission settings | each setting `settings.ts` names matches what the deploy would set now | the server's environment, through `wall-probe.ts machine` |
| Trusted emails | `CW_PROXIED_TRUSTED_EMAILS` is unset or holds the owner alone | the same |
| Loopback uid policy | the lead's uid is refused and `CW_LOOPBACK_SKIPS_ACCESS` is `1`; the users it still admits are listed | the same, and `/etc/passwd` |
| `git-push.json` | it parses; each repo is listed with whether every push waits (a `.github/` change always does) | the file on the volume |
| Deploy key | the lead's key is read-only on GitHub | its public half, matched against `gh api repos/<repo>/keys` for each repo the lead clones or may push to |
| Tunnel ingress | cloudflared runs the named tunnel, whose ingress sends the project's host to the server and everything else to a 404 | Cloudflare's API |

Across the account it checks three more things. When the router config has
more than one origin, `ONE_ADDRESS_ORIGIN` must be set to one of them. No
service token may be admitted by two projects' Access applications. A
Cloudflare plan in CI mode (no lock, nothing applied) must have no changes,
which shows that the live Access applications and policies, the tunnel
configurations and the router Worker's bindings match the config. The
probe's output carries addresses, hostnames, audiences and uids and no
secret, and the report prints only whether each one matches. `--no-drift`
leaves this part out.

It runs on the Mac and reads Cloudflare with read-only credentials only: the
Keychain entries `cloudflare-api-token-read` (an API token with read
permissions on the zone, Access, tunnels and Workers, the same token as the
repository's read-only `CLOUDFLARE_API_TOKEN` secret) and
`cloudflare-r2-tfstate-read` (JSON `{accessKeyId, secretAccessKey}`, the
state bucket's Object Read key). It uses them for the outputs, the plan and
the tunnel ingress. Without both entries it stops; it never falls back to
`cloudflare-api-token` or `cloudflare-r2-tfstate`, which can write. Fly reads
use the org token the way `machine:deploy` does, and the deploy-key read uses
the Mac's `gh` login.

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
