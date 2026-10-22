# Project machine

Everything one client project's Fly Machine needs: the image, its Fly
config, the process tree it runs, its encrypted backups and restore, and the
scripts that stand it up. How to run them is
[docs/process/project-machine.md](../../docs/process/project-machine.md).

| Script | Run where | What it does |
| --- | --- | --- |
| `bun run machine:deploy --project <name>` | the Mac | Creates or updates the app, volume, backup keys, bucket, write-only credential, secrets and machine. A second run changes nothing |
| `bun run machine:restore --project <name>` | the Mac | Puts the newest snapshot back onto the machine; the old data dir is moved aside |
| `bun run machine:drill --project <name>-test` | the Mac | Backs up, destroys the machine and volume, redeploys, restores, and compares the docs |
| `backup.ts`, `entrypoint.sh` | the machine | The backup loop and the process tree |
| `drill-probe.ts` | the machine | Seeds the drill board and fingerprints its docs, on loopback |

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
  cannot list, so it would have to guess one.
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
`project-machine-restore.test.ts` builds a data dir through a real server,
snapshots it, restores it and reads it back from a second server;
`project-machine-snapshot.test.ts` holds the refusals and the write-only
upload. The image, the Fly deploy and the Tigris calls are proved by
`machine:drill`, not by a test.
