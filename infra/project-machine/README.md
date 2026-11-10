# Project machine

Everything one client project's Fly Machine needs: the image, its Fly
config, the process tree it runs, its encrypted backups and restore, and the
scripts that stand it up. How to run them is
[docs/process/project-machine.md](../../docs/process/project-machine.md).

| Script | Run where | What it does |
| --- | --- | --- |
| `bun run machine:deploy --project <name>` | the Mac | Creates or updates the app, volume, backup keys, bucket, write-only credential, secrets (the owner and Access settings among them, `settings.ts`) and machine, and with `--tunnel named` the machine's tunnel token, read from the API by the tunnel id in `terraform output` (`tunnel-plan.ts`). A second run changes nothing |
| `bun run machine:restore --project <name>` | the Mac | Puts the newest snapshot back onto the machine; the old data dir is moved aside |
| `bun run machine:drill --project <name>-test` | the Mac | Backs up, destroys the machine and volume, redeploys, restores, and compares the docs |
| `entrypoint.sh`, `run-as.sh` | the machine | The process tree, supervised as root: the server as `cw`, cloudflared as `cwtunnel`, the lead agent as `lead`, so no child's user holds another's secrets |
| `release-cli.ts`, `release-store.ts`, `release-manifest.ts` | the machine | As `cwrelease`: checks for a newer release CI signed, chooses which app the server boots, and rolls back a release that did not stay up |
| `release-publish.ts` | CI (`server-release.yml`) | Builds and signs a release; `keygen` makes the signing pair once |
| `lead.sh` | the machine | Keeps the lead agent's Claude Code session running in tmux, and starts it again within a minute when it ends |
| `lead-egress.ts`, `lead-egress-plan.ts`, `lead-egress.allow` | the machine | The lead's and the dev server's network wall: iptables rules by owner match that allow them loopback only, loaded and probed at boot |
| `lead-proxy.ts`, `lead-proxy-plan.ts` | the machine | The wall's one way out: a CONNECT proxy on 127.0.0.1:3128, run as `cwproxy`, that opens only the host names in `lead-egress.allow`, with a matching TLS server name |
| `lead-memory.sh` | the machine | The lead's memory cap where there is no cgroup v2 memory controller: a root watchdog that kills the lead's processes once their total passes it |
| `github-known-hosts.txt` | the machine | GitHub's SSH host keys, pinned for the lead's git over SSH |
| `backup-once.sh`, `backup.ts` | the machine | One backup (data dir, with its events and agent notes, plus Claude Code transcripts): snapshot as `cw`, upload as `cwbackup`, so the server's user never holds the bucket credential |
| `store-uploader.ts`, `store-upload.ts` | any machine running sessions | Every 5 minutes, sends the new lines of each Claude Code transcript and analytics log to the transcript store, each sealed to its board's key; local-only boards never leave. Not installed anywhere yet |
| `drill-probe.ts` | the machine | Seeds the drill board and fingerprints its docs, on loopback |
| `bun run machine:approve-move --board <id> --project <name>` | the Mac | Asks one passkey that covers that board's wall check and move on that project for 30 minutes (`docs/process/keeper.md`). |
| `bun run machine:move-board --board <id> --project <name>` | the Mac | Moves one board onto the machine with the same ids (`board-bundle.ts`, `board-print.ts`), and archives the Mac's copy only when both fingerprints match |
| `board-probe.ts` | the machine | The move's importer and fingerprint, on loopback |
| `bun run machine:tokens` (`tokens.ts`, `token-list.ts`, `token-move.ts`, `token-usage.ts`) | the Mac | The central list of long-lived Claude tokens, of accounts Bryan owns only: add one, read each token's usage, move a project to another (`docs/process/project-machine.md`) |
| `lead-usage.ts` | the machine | The lead's status line command: keeps the session's rate limits for `machine:tokens usage` |

## Why Tigris for the bucket

Tigris is Fly's own object store: `fly storage create` makes a bucket with
the org token the deploy already uses, on the same bill, with no second
cloud account to open. Its IAM API can make a credential limited to
`s3:PutObject` under `snapshots/`. Measured on the test bucket on 22 Oct
2026, the machine's credential could:

- put a new snapshot (200);
- not read, head, list or delete one, and not put outside `snapshots/` (403);
- not write itself, or a key it makes, a policy over the bucket ("Member
  users are not allowed to create policies for buckets they do not own").

Two things it can still do, which GCS's `objectCreator` role could not:

- **Overwrite a snapshot whose name it knows.** S3's `PutObject` covers
  replacing an object. Names carry a random suffix and the credential
  cannot list, so it would have to guess one. Tigris does not implement
  `PutBucketVersioning` (it answers 501, which stopped a real deploy on
  4 November 2026), so the deploy makes the bucket a Tigris snapshot bucket
  instead (`enable-snapshots`). A snapshot bucket keeps every version: a
  replaced snapshot is read back with `X-Tigris-Snapshot-Version: <unix ns>`
  set to any moment before the overwrite, and restored with a `CopyObject`
  carrying the same header. Only a `DeleteObject` naming a version removes
  one, and the machine's key may only put. Tigris refuses the switch while a
  lifecycle rule exists, so the deploy removes the 30-day rule an older run
  set (`remove-lifecycle`) first. **A snapshot bucket cannot expire objects,
  so nothing prunes old snapshots now**; pruning would have to run on the
  Mac with the admin key. The calls are the ones Tigris's own SDK makes
  (`PATCH /<bucket>` with `{"type":1}`, read back from
  `GET /<bucket>?metadata`). This is code only: no run has yet converted a
  live bucket, and whether the admin key `fly storage create` made may
  change the bucket's type is untested. A refusal fails the deploy with the
  API's error code.
- **Create buckets and keys of its own, and list the org's bucket names.**
  Tigris gives every key these "default allowed operations". The keys it
  makes have no rights over this bucket. Turning them off is a switch on the
  key in the Tigris dashboard; there is no API for it yet.

Nothing it creates can read a snapshot. GCS stays the stronger write-only story and `backup.ts` still works with
any S3-compatible endpoint; it is one `BACKUP_S3_ENDPOINT` away if the
overwrite case ever matters more than one bill.

## Tests

`packages/server/test/project-machine-deploy.test.ts` holds the deploy's
decisions: names, which steps a run plans for each state, the fly.toml it
writes, and how it reads Fly's and Tigris's output. No test calls Fly.
`project-machine-tunnel.test.ts` holds the named tunnel's readers
(`tunnel-plan.ts`): how the tunnel Terraform made, and its token, are read
from the Terraform outputs. The tunnel itself is
`infra/cloudflare/`'s, tested there. No test calls Cloudflare.
`project-machine-restore.test.ts` builds a data dir through a real server,
with a board's event log and agent-note log, and a transcripts dir beside
it; snapshots them, restores them, checks the logs and transcripts byte for
byte and reads the board back from a second server.
`transcript-store.test.ts` holds the store's uploader: which key each board's files are sealed to, that a local-only board sends nothing, and that a run cut short resumes without repeating or skipping a byte. `transcript-store-uploader.test.ts` holds its keys file and a pass against a stand-in bucket on loopback, which sees PUTs only.
`project-machine-token-list.test.ts` holds the token list: a deploy with no sign-in, the marker on a booted machine, a move, and the usage reading and report.
`project-machine-move-board.test.ts` moves a board between two real servers on loopback and checks when the source is not archived; `project-machine-board-bundle.test.ts` checks the shared-file merge and that a hand-made bundle is refused; `bound-file-sync.test.ts` keeps a moved board's doc and its `.md` in step both ways.
`project-machine-snapshot.test.ts` holds the refusals, the first snapshot
format and the write-only upload. `project-machine-entrypoint.test.ts` runs
`entrypoint.sh` and `backup-once.sh` with stand-ins for `setpriv` and each
program, and checks which user each child runs as and which secrets it holds. `project-machine-lead-egress.test.ts`, `project-machine-lead-proxy.test.ts`, `project-machine-lead-memory.test.ts` and `project-machine-lead-wall-boot.test.ts` hold the lead's network wall, its proxy and the memory watchdog with a fake iptables, a loopback upstream and a fake `/proc`; `project-machine-lead-limits-container.test.ts` runs both on a Linux kernel in Docker, only with `CW_CONTAINER_TESTS=1`. The image, the Fly deploy and the Tigris calls are proved by
`machine:drill`, not by a test; the Cloudflare configuration by
`bun run cf:plan` against the real account.
