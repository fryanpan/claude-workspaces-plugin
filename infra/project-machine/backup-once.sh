#!/usr/bin/env bash
# One backup, as root, in two halves under two users, so the bucket
# credential is never in a process the board server's user owns:
#
#   1. cw snapshots the data dir and encrypts it to BACKUP_RECIPIENT, into an
#      outbox on the volume. It holds no secret: the recipient is a public key.
#   2. cwbackup uploads that file with the bucket credential, and holds
#      nothing else. The outbox is cw's, group cwbackup, setgid, so the
#      snapshot is readable by cwbackup and by no other user.
#
# entrypoint.sh runs this on its backup interval; `machine:drill` runs it over
# `fly ssh console`. A snapshot left by a failed upload is replaced next time.
set -euo pipefail

DATA_ROOT=/data
APP=/app
HERE="$(cd "$(dirname "$0")" && pwd)"
OUTBOX="$DATA_ROOT/backup-outbox"
SNAPSHOT="$OUTBOX/snapshot.cwsnap"

if [ "$(id -u)" != 0 ]; then
  echo "[backup] backup-once.sh must run as root, to hand each half to its own user" >&2
  exit 2
fi

# shellcheck source=run-as.sh
. "$HERE/run-as.sh"

mkdir -p "$OUTBOX"
chown cw:cwbackup "$OUTBOX"
chmod 2750 "$OUTBOX"

status=0
(
  drop_secrets
  umask 027
  run_as cw bun run "$APP/infra/project-machine/backup.ts" --out "$SNAPSHOT"
) || status=$?
# backup.ts creates the snapshot 0600, so its group cannot read it even in
# the setgid outbox. Root opens it to that group, cwbackup, and no wider.
if [ "$status" = 0 ]; then
  chmod 0640 "$SNAPSHOT" || status=$?
fi
if [ "$status" = 0 ]; then
  (
    only_env PATH BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_REGION BACKUP_S3_PREFIX \
      BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
    run_as cwbackup bun run "$APP/infra/project-machine/backup.ts" --upload "$SNAPSHOT"
  ) || status=$?
fi
(
  only_env PATH
  run_as cw rm -f "$SNAPSHOT"
) || true
exit "$status"
