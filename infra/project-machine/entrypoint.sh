#!/usr/bin/env bash
# The project machine's one process tree: the board server on loopback, the
# Cloudflare Tunnel it is reached through, the project's lead agent, a
# loopback health check, and the backup loop. If any of them exits, everything stops and the machine exits,
# and Fly's restart policy starts it again.
#
# This shell stays root and supervises; each child runs as its own user and
# gets only the secrets it uses:
#
#   cw        the board server. Never holds the tunnel token or the bucket
#             credential.
#   cwtunnel  cloudflared, with the tunnel token and nothing else.
#   cwbackup  the backup upload, with the bucket credential and nothing else
#             (backup-once.sh).
#   lead      the lead agent's Claude Code session (lead.sh), with its own
#             sign-in, its board's socket and its repo's deploy key, and
#             nothing else. The server refuses its loopback TCP calls, so it
#             reaches only its own board, through that board's socket.
#
# A user's processes can read each other's environment (/proc/<pid>/environ),
# so a secret kept from the server has to live under another uid, not merely
# in another process. Root's environment, which holds every secret, is
# readable by no other user. Every secret is passed in the environment, never
# as an argument, because any user can read any process's arguments.
set -euo pipefail

# The volume. Overridable only so a test can run this off a machine.
DATA_ROOT="${CW_MACHINE_DATA_ROOT:-/data}"
export CW_DATA_DIR="${CW_DATA_DIR:-$DATA_ROOT/cw}"
PORT=8787
APP=/app
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=run-as.sh
. "$HERE/run-as.sh"

TRANSCRIPTS="${BACKUP_TRANSCRIPTS_DIR:-$DATA_ROOT/claude-projects}"
# The lead's working folder and transcripts, on the volume.
LEAD_ROOT="$DATA_ROOT/lead"
# The lead's uid, fixed in the Dockerfile. The server refuses its TCP calls.
LEAD_UID=10004
# One unix socket per board (packages/server/src/board-sockets.ts): cw's,
# with group lead allowed through, so the lead reaches its own board's socket
# and no other.
SOCKETS="$DATA_ROOT/boards"
CGROUP="${CW_MACHINE_CGROUP_ROOT:-/sys/fs/cgroup}"
LEAD_MEMORY_MAX="${CW_LEAD_MEMORY_MAX:-1280M}"

if [ "$(id -u)" != 0 ]; then
  echo "[machine] entrypoint.sh must start as root, to run each child as its own user" >&2
  exit 2
fi

# Root never changes the owner of a path cw could have swapped for a link.
# The volume's root is root's and only root writes it, so cw cannot rename
# or replace the names in it while root works; the directories cw is given
# are checked for a link before root touches them. Nothing runs as cw yet:
# a machine that stops stops every process, so none survives into this boot.
# A volume from before this rule had /data owned by cw; this takes it back.
chown root:root "$DATA_ROOT"
chmod 0755 "$DATA_ROOT"
for d in "$CW_DATA_DIR" "$TRANSCRIPTS" "$HOMES/cw/.claude" "$LEAD_ROOT" "$SOCKETS"; do
  if [ -L "$d" ]; then
    echo "[machine] $d is a symlink; refusing to start" >&2
    exit 2
  fi
done
mkdir -p "$CW_DATA_DIR" "$TRANSCRIPTS" "$HOMES/cw/.claude" "$LEAD_ROOT" "$SOCKETS"
# Claude Code writes session transcripts to ~/.claude/projects. The home
# directory is the image's and does not survive a restart, so that one
# folder is a link onto the volume, where backup.ts snapshots it. The
# rest of ~/.claude (credentials among it) stays off the volume and out
# of every backup.
ln -sfn "$TRANSCRIPTS" "$HOMES/cw/.claude/projects"
chown -h cw:cw "$CW_DATA_DIR" "$TRANSCRIPTS" "$HOMES/cw/.claude"
chown -h lead:lead "$LEAD_ROOT"
chown -h cw:lead "$SOCKETS"
# Each user's folders are its own: the lead runs as another user so that it
# cannot read the server's data dir, which holds the board's tokens and keys,
# except through the server. And the server cannot read the lead's folder, so
# no doc is ever bound to a file the lead can write (docs/process/project-machine.md).
chmod 0700 "$CW_DATA_DIR" "$TRANSCRIPTS" "$LEAD_ROOT"
chmod 0710 "$SOCKETS"
# Copies a restore set aside (restore-machine.ts) were 0755 before this rule.
for d in "$DATA_ROOT"/*.before-restore-*; do
  if [ -d "$d" ] && [ ! -L "$d" ]; then chmod 0700 "$d"; fi
done

log() { echo "[machine] $(date -u +%FT%TZ) $*"; }

# Maintenance: with this file on the volume nothing starts, so the data dir
# can be moved aside and restored over `fly ssh console`. Remove it and
# restart the machine to come back.
if [ -e "$DATA_ROOT/maintenance" ]; then
  log "$DATA_ROOT/maintenance exists: starting nothing"
  exec sleep infinity
fi

: "${CW_TUNNEL_MODE:=named}"
if [ "$CW_TUNNEL_MODE" != quick ]; then
  : "${CLOUDFLARE_TUNNEL_TOKEN:?set it with fly secrets set}"
fi
if [ -z "${BACKUP_RECIPIENT:-}" ] || [ -z "${BACKUP_S3_BUCKET:-}" ]; then
  log "BACKUP_RECIPIENT or BACKUP_S3_BUCKET unset: NO BACKUPS WILL RUN"
fi

pids=()

# The board the lead leads. Its socket is the only one the lead may open.
LEAD_BOARD="${CW_LEAD_BOARD:-}"
if [ -n "$LEAD_BOARD" ] && ! [[ $LEAD_BOARD =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
  log "CW_LEAD_BOARD is not a board id; ignoring it"
  LEAD_BOARD=""
fi

(
  drop_secrets
  export CW_BOARD_SOCKET_DIR="$SOCKETS" CW_BOARD_SOCKET_SHARED="$LEAD_BOARD" \
    CW_LOOPBACK_REFUSED_UIDS="$LEAD_UID"
  run_as cw bun run "$APP/packages/server/src/bin.ts" \
    --port "$PORT" --host 127.0.0.1 --no-port-walk \
    --data-dir "$CW_DATA_DIR" \
    --widget-dist "$APP/packages/widget/dist" \
    --workspaces-app-dist "$APP/packages/workspaces-app/dist"
) &
pids+=($!)

# cloudflared reads TUNNEL_TOKEN from its environment; ingress (the one
# address to http://localhost:8787) is set on the tunnel in Cloudflare.
# A quick tunnel (CW_TUNNEL_MODE=quick) needs no Cloudflare account: it gets
# a random trycloudflare.com address, printed in the machine's logs, and is
# for a test machine only. Its visitors carry cf-ray and no Access identity,
# so the server treats them as the internet and lets them reach nothing.
if [ "$CW_TUNNEL_MODE" = quick ]; then
  (
    only_env PATH
    run_as cwtunnel cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT"
  ) &
else
  (
    export TUNNEL_TOKEN="$CLOUDFLARE_TUNNEL_TOKEN"
    only_env PATH TUNNEL_TOKEN
    run_as cwtunnel cloudflared tunnel --no-autoupdate run
  ) &
fi
pids+=($!)

# The lead agent's memory: a cgroup v2 group of its own with a ceiling, so a
# lead that grows is killed alone and the server keeps running. Prints the
# group, or fails when the machine has no memory controller to use.
lead_cgroup() {
  local cg="$CGROUP/cw-lead"
  grep -qw memory "$CGROUP/cgroup.controllers" 2>/dev/null || return 1
  grep -qw memory "$CGROUP/cgroup.subtree_control" 2>/dev/null ||
    echo +memory >"$CGROUP/cgroup.subtree_control" 2>/dev/null || return 1
  if [ -L "$cg" ]; then return 1; fi
  mkdir -p "$cg" && echo "$LEAD_MEMORY_MAX" >"$cg/memory.max" || return 1
  if [ -e "$cg/memory.oom.group" ]; then echo 1 >"$cg/memory.oom.group" || true; fi
  echo "$cg"
}

# The lead agent, when the machine has a Claude Code sign-in for it and a
# board to lead (machine:deploy sets both). It holds no secret but its own
# sign-in and deploy key: not the server's Claude key, not the tunnel token,
# not the bucket credential. The server holds neither of those
# (MACHINE_SECRETS, run-as.sh). Root starts its supervisor again whenever it
# exits, so the lead, which can kill its own processes, cannot stop the
# machine: this loop, not the supervisor, is what wait -n watches.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  log "CLAUDE_CODE_OAUTH_TOKEN unset: no lead agent runs"
elif [ -z "$LEAD_BOARD" ]; then
  log "CW_LEAD_BOARD unset: no lead agent runs"
else
  if cg=$(lead_cgroup); then
    log "the lead's memory is capped at $LEAD_MEMORY_MAX"
  else
    cg=""
    log "the lead's memory is NOT capped: no cgroup v2 memory controller at $CGROUP"
  fi
  (
    child=""
    trap 'if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; fi; exit 0' TERM INT
    while :; do
      (
        if [ -n "$cg" ]; then
          echo "$BASHPID" >"$cg/cgroup.procs" || log "could not join $cg"
        fi
        app="${FLY_APP_NAME:-project}"
        export CW_BOARD_SOCKET="$SOCKETS/$LEAD_BOARD.sock" CW_WORKSPACE_ID="$LEAD_BOARD" \
          CW_AGENT_NAME="${CW_LEAD_AGENT_NAME:-${app#cw-}-lead}" \
          CW_LEAD_ROOT="$LEAD_ROOT" DISABLE_AUTOUPDATER=1 TERM=xterm-256color SHELL=/bin/bash
        only_env PATH TERM SHELL CLAUDE_CODE_OAUTH_TOKEN CW_BOARD_SOCKET CW_WORKSPACE_ID \
          CW_AGENT_NAME CW_LEAD_ROOT CW_LEAD_REMOTE_CONTROL CW_LEAD_GITHUB_DEPLOY_KEY \
          DISABLE_AUTOUPDATER
        umask 077
        run_as lead bash "$HERE/lead.sh" supervise
      ) &
      child=$!
      status=0
      wait "$child" || status=$?
      log "the lead's supervisor exited ($status); starting it again in 10s"
      sleep 10 &
      wait $! || true
    done
  ) &
  pids+=($!)
fi

# The health check. Fly's own checks reach a machine over its private
# address, and this server listens on loopback only, so the check runs here:
# any HTTP status from loopback is alive (the same rule as the Mac's
# supervisor, docs/architecture/supervisor.md). A first bind gets 240s; after
# that, three misses 25s apart exit the machine.
(
  sleep 240
  misses=0
  while :; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -H "host: localhost:$PORT" "http://127.0.0.1:$PORT/api/deploy" || true)
    if [ "$code" = 000 ]; then
      misses=$((misses + 1))
      log "health: no answer on 127.0.0.1:$PORT ($misses/3)"
      if [ "$misses" -ge 3 ]; then exit 1; fi
    else
      misses=0
    fi
    sleep 25
  done
) &
pids+=($!)

# Backups: the first an hour after boot, then every BACKUP_INTERVAL_HOURS. A
# failed backup is logged and retried next round; it does not stop the board.
if [ -n "${BACKUP_RECIPIENT:-}" ] && [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  (
    interval=$((${BACKUP_INTERVAL_HOURS:-6} * 3600))
    sleep 3600
    while :; do
      bash "$HERE/backup-once.sh" ||
        log "backup failed; next attempt in ${BACKUP_INTERVAL_HOURS:-6}h"
      sleep "$interval"
    done
  ) &
  pids+=($!)
fi

stop() { kill -TERM "${pids[@]}" 2>/dev/null || true; wait || true; }
trap 'stop; exit 0' TERM INT

set +e
wait -n
status=$?
set -e
log "a child exited ($status); stopping the machine"
stop
exit 1
