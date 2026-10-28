# A project machine on Fly

One client project's board server runs on a Fly Machine of its own, reached
only through a Cloudflare Tunnel the machine dials out to, with its data dir
backed up, encrypted, to a bucket of the project's own. Every step is a
script an agent runs from the Mac; the files are in `infra/project-machine/`.
`<project>` below is a short lower-case name, used for every resource.

## What is on the machine

| Part | What it does |
| --- | --- |
| `Dockerfile` | The board server and both browser bundles, plus cloudflared, and three users: `cw` for the server, `cwtunnel` for cloudflared, `cwbackup` for the backup upload |
| `fly.toml` | One machine, one volume at `/data`, no public service ports. `deploy.ts` writes the app name and size in at deploy time |
| `entrypoint.sh` | Stays root and starts the server on `127.0.0.1:8787` as `cw`, the tunnel as `cwtunnel`, a loopback health check and the backup loop; if any stops, the machine exits and Fly restarts it. Each child gets only its own secrets, so the server's user cannot read the tunnel token or the bucket credential |
| `backup-once.sh`, `backup.ts` | Tars the data dir and the agents' session transcripts and encrypts them to the project's public key as `cw`, then PUTs the file to the bucket as `cwbackup`. Every 6 hours, the first an hour after boot |
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
    [--tunnel quick|named] [--router-config <path>] [--dry-run]
```

It reads what exists and does only what is missing:

1. The app `cw-<project>` in the shared org, on a private network of the same
   name, so no other project's machine can reach it.
2. The volume `cw_data`.
3. The backup key pair. The identity goes into the Keychain and is never
   replaced: a new one would orphan every snapshot.
4. The Tigris bucket `cw-<project>-backups`. Its admin credential goes into
   the Keychain as `cw-<project>-bucket-admin`; the machine never gets it.
5. The machine's write-only credential (`cw-<project>-backup-writer`), and a
   rule on the bucket that expires snapshots after 30 days, since the machine
   cannot delete.
6. The machine's secrets, set through `fly secrets import` on stdin so no
   value is ever an argument.
7. The image, built by Fly's remote builder from `git archive <ref>` (HEAD by
   default), so no local `node_modules`, data dir or uncommitted file is in
   it. It is labelled with the commit; a run on the same commit and size does
   not rebuild.

A run over a finished project prints `nothing to do`. The last lines name the
machine, its commit and size, and the tunnel address.

Volume size: 1 GB holds a board; a project with a staging site wants 20. Fly
keeps its own daily volume snapshots for five days on top of these backups.

### The tunnel

`--tunnel quick` (the default until the Cloudflare token exists) runs a
cloudflared quick tunnel: a random `trycloudflare.com` address, new on every
machine start, with no Cloudflare account. Its visitors carry `cf-ray` and no
Access identity, so the server answers them `403 unknown_host` on every
path. It proves the machine can be reached; it is not a way in.

`--tunnel named` is the production path. Before it touches Fly, the deploy
reads Cloudflare and does only what is missing there:

1. The tunnel `cw-<project>`, configured from Cloudflare rather than from a
   file on the machine. The zone and its account come from the zone lookup
   of `router.local.json`'s `zone`.
2. The tunnel's ingress: the project's own hostname,
   `<project>-<first label of the one address>.<zone>` (so
   `riverbend-workspaces.<zone>` beside `workspaces.<zone>`), to
   `http://localhost:8787`, and a 404 for every other hostname. That is the
   Host header the router Worker sends.
3. The origin hostname `<project>-origin.<zone>`: a proxied CNAME to
   `<tunnel id>.cfargotunnel.com`.
4. The tunnel's token, read from Cloudflare into memory and set as the
   machine's `CLOUDFLARE_TUNNEL_TOKEN` through `fly secrets import` on stdin.
   A run that creates the tunnel sets it again, since the old value belongs
   to a tunnel that no longer exists. A machine that ran a quick tunnel loses
   its `CW_TUNNEL_MODE` secret, so it starts the named one.

It stops, having changed nothing anywhere, when it finds two live tunnels of
the name, a tunnel configured from a file, a record at the origin hostname
that is not a proxied CNAME to this tunnel, or an Access application covering
the origin hostname. It never repoints or deletes what it finds. The last
lines name the origin hostname and the entry to add to the router's
`projects` before `bun run router:deploy`.

The Cloudflare token needs, on top of what `router:deploy` uses: Cloudflare
Tunnel Edit and Access: Apps and Policies Read on the account, and DNS Edit on
the zone. What stays a person's step: the project's Access application on its
own hostname, the router entry, and the server's `CW_PROXIED_TRUSTED_HOSTS` and
Access settings (board router README, "Each project's side").

### Checking it

```bash
fly ssh console --app cw-<project> -C \
  "curl -s -H 'host: localhost:8787' http://127.0.0.1:8787/api/deploy"
```

The curl answers with a JSON `liveness` field (and a 501 for the deploy
half: a project machine is deployed by `machine:deploy`, never by pulling
itself). Then add the project's boards under the machine's origin hostname in
the router's `BOARD_ORIGINS`.

The plan's unchecked point belongs here too: whether Claude Code's Remote
Control session runs on this machine in a long-lived terminal. That needs the
lead's own user on the machine and is the next task, not this image.

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

## Cost

By Fly's price list (October 2026, cheapest regions; `sjc` may cost a little
more), a `shared-cpu-1x` machine with 512 MB is $3.69 a month running all
the time and a volume $0.15 per GB-month, attached or not. Tigris bills
storage at its own list price; the drill board's snapshot, transcripts included, was 10 KB. The remote
builder Fly creates on the first deploy stops itself when idle.
