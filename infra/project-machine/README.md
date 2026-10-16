# Project machine

Everything one client project's Fly Machine needs: the image, its Fly
config, the process tree it runs, and its encrypted backups and restore.
The steps to stand one up, take the first backup and run a restore drill are
[docs/process/project-machine.md](../../docs/process/project-machine.md).

Tests: `packages/server/test/project-machine-restore.test.ts` builds a data
dir through a real server, snapshots it with `backup.ts --out`, restores it
with `restore.ts` and reads the board and its docs back from a second server.
`packages/server/test/project-machine-snapshot.test.ts` holds the refusals
and the write-only upload.

Not tested here: the image build and the Fly deploy, which need Docker and a
Fly account, and the upload against real GCS.
