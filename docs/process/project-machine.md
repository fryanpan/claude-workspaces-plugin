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
| `CW_PUBLIC_BASE_URL` | `https://` and the project's first host in `infra/access-apps/access.local.json` |
| `CF_ACCESS_TEAM_DOMAIN` | the account's Access organization (`auth_domain`) |
| `CF_ACCESS_AUD` | the Access application `board <project>` |
| `CF_ACCESS_HOST_AUDS` | each of the project's hosts, to that audience |
| `CW_PROXIED_TRUSTED_HOSTS` | the project's hosts |

The account is the one the Cloudflare token sees; a token that sees more than
one stops the run. The token needs Access: Apps and Policies Read and Access:
Organizations, Identity Providers, and Groups Read on the account. Through
the keeper both reads run without a passkey. `--access-config <path>` reads another file in place of
`access.local.json`. A project that file does not list gets only the owner
address. A project whose Access application does not exist yet (`bun run
access:apply --apply` makes it) gets the owner and the public address, and
the run says which settings it left unset; it does not fail. Two applications
of the name stop the run before anything changes.

Not set by deploy: `CW_PROXIED_TRUSTED_EMAILS`, which defaults to
`CW_OWNER_EMAIL`, and the share settings (`CF_ACCESS_SHARE_AUD`,
`CW_SHARE_LINK_HOSTS`, `CF_SHARE_BASE_HOSTNAME`, `CF_ACCOUNT_ID`), which need
a share application this repo does not make per project. A setting that
exists is never set again, so a value that changed (an application made
again, a host added) takes `fly secrets unset <name>` and another run.

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
own hostname (`bun run access:apply --apply`) and the router entry. The
server's `CW_PROXIED_TRUSTED_HOSTS` and Access settings are set by deploy
("The owner and Access settings", above).

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
      "serviceToken": {"clientId": "<client id>.access", "secretService": "cw-<project>-access-secret"}}}}
   ```

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
The MCP child then sends both `cf-access-client-*` headers on every request,
and the launcher uses the node relay, because the compiled relay cannot read
Keychain.

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

## Cost

By Fly's price list (October 2026, cheapest regions; `sjc` may cost a little
more), a `shared-cpu-1x` machine with 512 MB is $3.69 a month running all
the time and a volume $0.15 per GB-month, attached or not. Tigris bills
storage at its own list price; the drill board's snapshot, transcripts included, was 10 KB. The remote
builder Fly creates on the first deploy stops itself when idle.
