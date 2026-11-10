#!/usr/bin/env bash
# The project machine's one process tree: the board server on loopback, the
# Cloudflare Tunnel it is reached through, the project's lead agent, a
# loopback health check, the backup loop and the release check. If any of them
# exits, everything stops and the machine exits, and Fly's restart policy
# starts it again. The release check exits on purpose when it has downloaded
# a newer signed release, so that restart is the upgrade
# (docs/process/project-machine.md, "Releases").
#
# This shell stays root and supervises; each child runs as its own user and
# gets only the secrets it uses:
#
#   cw        the board server. Never holds the tunnel token or the bucket
#             credential.
#   cwtunnel  cloudflared, with the tunnel token and nothing else.
#   cwbackup  the backup upload, with the bucket credential and nothing else
#             (backup-once.sh).
#   cwrelease the release check and the boot's choice of release
#             (release-cli.ts), with no secret at all.
#   lead      the lead agent's Claude Code session (lead.sh), with its own
#             sign-in, its board's socket and its repo's deploy key, and
#             nothing else. The server refuses its loopback TCP calls, so it
#             reaches only its own board, through that board's socket. Its
#             connections reach loopback only, and out only through the
#             proxy to the hosts in lead-egress.allow (wall_network); its
#             memory has a ceiling (lead_cgroup, else lead-memory.sh).
#   cwproxy   that proxy (lead-proxy.ts), with PATH and nothing else.
#   cwdev     the project's dev server, when CW_DEV_SERVER_CMD names one, with
#             PATH and the proxy's address. It binds loopback; the board proxies it
#             (attach_app) behind the board's own sign-in. The server refuses
#             its loopback TCP calls, and it is in no board's socket group.
#             It runs code the lead writes, so it is behind the lead's
#             network wall too.
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
# The image's own app. Overridable only so a test can run this off a machine.
APP="${CW_MACHINE_APP_ROOT:-/app}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=run-as.sh
. "$HERE/run-as.sh"

TRANSCRIPTS="${BACKUP_TRANSCRIPTS_DIR:-$DATA_ROOT/claude-projects}"
# The lead's working folder and transcripts, on the volume.
LEAD_ROOT="$DATA_ROOT/lead"
# Uids fixed in the Dockerfile. Over loopback TCP the server admits itself
# (cw) alone, and the tunnel (cwtunnel) only for requests the edge stamped
# with cf-ray; every other user, root, the lead and cwbackup among them, is
# refused (packages/server/src/middleware/loopback-uid-door.ts). Root keeps
# the power to switch users: a machine tool that calls the server's REST runs
# as cw (`asCw`, infra/project-machine/mac-ops.ts).
CW_UID=10001
TUNNEL_UID=10002
# One unix socket per board (packages/server/src/board-sockets.ts), in a
# folder of cw's that group cwboard (cw and lead, fixed in the Dockerfile) may
# enter and not list. Only the lead's board's socket is that group's, mode
# 660, so the lead reaches that socket and no other, and no other user
# reaches any.
SOCKETS="$DATA_ROOT/boards"
# Server releases CI published and this machine checked (release-store.ts):
# cwrelease's, readable by all, so the server runs them and cannot change them.
RELEASES="$DATA_ROOT/releases"
RELEASE_CLI="$APP/infra/project-machine/release-cli.ts"
# The public key baked into the image. Without it the machine never updates
# itself and runs the image's app.
RELEASE_KEY="$APP/infra/project-machine/release-signing-key.pub"
BOARD_GID=10010
CGROUP="${CW_MACHINE_CGROUP_ROOT:-/sys/fs/cgroup}"
LEAD_MEMORY_MAX="${CW_LEAD_MEMORY_MAX:-1280M}"
# The lead's uid, fixed in the Dockerfile, and /proc. Overridable only so a
# test can run this off a machine.
LEAD_UID=10004
PROC="${CW_MACHINE_PROC_ROOT:-/proc}"
# The dev server's folder. Group cwdevsrc (cwdev and lead, fixed in the
# Dockerfile) owns it, setgid, so the lead's checkout there is the one the
# dev server reads and the dev server's caches are ones the lead can clear.
# No other user enters it.
DEV_ROOT="$DATA_ROOT/dev"

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
for d in "$CW_DATA_DIR" "$TRANSCRIPTS" "$HOMES/cw/.claude" "$LEAD_ROOT" "$SOCKETS" "$RELEASES" "$DEV_ROOT"; do
  if [ -L "$d" ]; then
    echo "[machine] $d is a symlink; refusing to start" >&2
    exit 2
  fi
done
mkdir -p "$CW_DATA_DIR" "$TRANSCRIPTS" "$HOMES/cw/.claude" "$LEAD_ROOT" "$SOCKETS" "$RELEASES" "$DEV_ROOT"
# Claude Code writes session transcripts to ~/.claude/projects. The home
# directory is the image's and does not survive a restart, so that one
# folder is a link onto the volume, where backup.ts snapshots it. The
# rest of ~/.claude (credentials among it) stays off the volume and out
# of every backup.
ln -sfn "$TRANSCRIPTS" "$HOMES/cw/.claude/projects"
chown -h cw:cw "$CW_DATA_DIR" "$TRANSCRIPTS" "$HOMES/cw/.claude"
chown -h lead:lead "$LEAD_ROOT"
chown -h cw:cwboard "$SOCKETS"
chown -h cwrelease:cwrelease "$RELEASES"
chown -h cwdev:cwdevsrc "$DEV_ROOT"
# Each user's folders are its own: the lead runs as another user so that it
# cannot read the server's data dir, which holds the board's tokens and keys,
# except through the server. And the server cannot read the lead's folder, so
# no doc is ever bound to a file the lead can write (docs/process/project-machine.md).
chmod 0700 "$CW_DATA_DIR" "$TRANSCRIPTS" "$LEAD_ROOT"
chmod 0710 "$SOCKETS"
chmod 0755 "$RELEASES"
chmod 2770 "$DEV_ROOT"
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

# Which app the server runs: a release on trial, the current release, or the
# image's own (release-store.ts). A trial still set from the last boot did
# not stay up, so this is also where a bad release is rolled back. Any
# failure here boots the image's app.
release_cli() {
  only_env PATH CW_RELEASE_CHANNEL_URL
  run_as cwrelease bun "$RELEASE_CLI" "$@" --root "$RELEASES" --image "$APP" --public-key "$RELEASE_KEY"
}
SERVER_APP=$(release_cli select) || SERVER_APP=""
if [ -z "$SERVER_APP" ] || [ ! -f "$SERVER_APP/packages/server/src/bin.ts" ]; then
  SERVER_APP="$APP"
fi
log "the server runs from $SERVER_APP"

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
    CW_BOARD_SOCKET_GROUP="$BOARD_GID" CW_LOOPBACK_ALLOWED_UIDS="$CW_UID" \
    CW_LOOPBACK_EDGE_UIDS="$TUNNEL_UID"
  run_as cw bun run "$SERVER_APP/packages/server/src/bin.ts" \
    --port "$PORT" --host 127.0.0.1 --no-port-walk \
    --data-dir "$CW_DATA_DIR" \
    --widget-dist "$SERVER_APP/packages/widget/dist" \
    --workspaces-app-dist "$SERVER_APP/packages/workspaces-app/dist"
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

# The lead and the dev server's network wall (lead-egress.ts): their
# connections reach loopback and nothing else, DNS included. Their way out is
# the CONNECT proxy on 127.0.0.1:3128 (lead-proxy.ts), run as cwproxy, which
# the wall does not hold; it opens a connection only to a host name in
# lead-egress.allow. Both run only behind it, because the dev server runs
# code the lead writes, so either could carry a board's data out. Applied
# once, by whichever of them starts first; CW_LEAD_EGRESS=open (a Fly
# secret, for a machine whose kernel cannot load the rules) runs both
# without it. The rules are applied as root, then a probe as the lead checks
# that a public address, an unlisted name and the proxy to an unlisted name
# are refused, and that the model API answers through the proxy. Every
# outcome is logged.
EGRESS_STATE=""
PROXY_URL=http://127.0.0.1:3128
egress() { (only_env PATH; bun "$HERE/lead-egress.ts" "$@"); }
wall_network() {
  if [ -n "$EGRESS_STATE" ]; then
    [ "$EGRESS_STATE" != failed ]
    return
  fi
  if [ "${CW_LEAD_EGRESS:-walled}" = open ]; then
    EGRESS_STATE=open
    log "the lead's network is NOT walled: CW_LEAD_EGRESS=open, so the lead and the dev server may connect anywhere"
    return 0
  fi
  local out status=0
  out=$(egress apply 2>&1) || status=$?
  if [ "$status" != 0 ]; then
    EGRESS_STATE=failed
    log "the lead's network is NOT walled: ${out:-lead-egress.ts apply exited $status}"
    return 1
  fi
  log "the lead's network wall is in: $out"
  # The proxy, started again 5s after it exits: a lead that crashes it loses
  # its own way out for 5s and never stops the machine.
  (
    while :; do
      (
        only_env PATH
        run_as cwproxy bun "$HERE/lead-proxy.ts" serve
      ) 2>&1 | while IFS= read -r line; do log "$line"; done
      log "the lead's proxy exited; starting it again in 5s"
      sleep 5
    done
  ) &
  pids+=($!)
  status=0
  out=$( (only_env PATH; run_as lead bun "$HERE/lead-egress.ts" probe) 2>&1) || status=$?
  case $status in
    0) log "the lead's network wall holds: $out" ;;
    3) log "the lead's network wall is in but UNPROVEN: $out" ;;
    *)
      EGRESS_STATE=failed
      log "the lead's network is NOT walled: the probe as the lead says: ${out:-it exited $status}"
      return 1
      ;;
  esac
  EGRESS_STATE=walled
}

# The proxy's address, for a walled child's environment. Every client the
# lead runs reads one of these spellings: Claude Code and Bun the upper case,
# git (libcurl) and curl the lower. ssh reads neither (lead.sh).
proxy_env() {
  [ "$EGRESS_STATE" = walled ] || return 0
  export HTTPS_PROXY="$PROXY_URL" HTTP_PROXY="$PROXY_URL" https_proxy="$PROXY_URL" \
    http_proxy="$PROXY_URL" NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
}
PROXY_VARS="HTTPS_PROXY HTTP_PROXY https_proxy http_proxy NO_PROXY no_proxy"

# The lead agent's memory: a cgroup v2 group of its own with a ceiling, so a
# lead that grows is killed alone and the server keeps running. Prints the
# group, or fails when the machine has no memory controller to use. A
# machine whose init mounted no cgroup filesystem gets one mounted here.
lead_cgroup() {
  local cg="$CGROUP/cw-lead"
  if [ -d "$CGROUP" ] && [ ! -e "$CGROUP/cgroup.controllers" ]; then
    mount -t cgroup2 cgroup2 "$CGROUP" 2>/dev/null || true
  fi
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
# The sign-in must be one a deploy or a move set for this org (review H2).
# CW_LEAD_TOKEN_ORG beside the token is the org's name for a token made by the
# org's own approval, or listed:<label>:<sha256> for one from the central list,
# which several orgs may share (token-list.ts, tokenMarker): the digest binds
# this org, the label and this exact token. A sign-in with no marker starts no
# lead, and neither does a marker copied from another org or a token set over
# a listed marker. The marker is never logged: its digest is of the sign-in.
LEAD_ORG="${FLY_APP_NAME:-}"
LEAD_ORG="${LEAD_ORG#cw-}"
LEAD_TOKEN_LABEL=""
lead_token_ok() {
  [ -n "$LEAD_ORG" ] || return 1
  local marker="${CW_LEAD_TOKEN_ORG:-}" sum
  [ "$marker" != "$LEAD_ORG" ] || return 0
  [[ $marker =~ ^listed:([a-z0-9][a-z0-9-]{0,31}):([0-9a-f]{64})$ ]] || return 1
  local label="${BASH_REMATCH[1]}" want="${BASH_REMATCH[2]}"
  sum=$(printf '%s' "listed:$LEAD_ORG:$label:$CLAUDE_CODE_OAUTH_TOKEN" | sha256sum) || return 1
  [ "${sum%% *}" = "$want" ] || return 1
  LEAD_TOKEN_LABEL="$label"
}
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  log "CLAUDE_CODE_OAUTH_TOKEN unset: no lead agent runs"
elif [ -z "$LEAD_BOARD" ]; then
  log "CW_LEAD_BOARD unset: no lead agent runs"
elif ! lead_token_ok; then
  log "the lead's sign-in was not made for ${LEAD_ORG:-this org} (CW_LEAD_TOKEN_ORG does not match it): no lead agent runs; machine:deploy on the Mac sets it one, or machine:tokens move"
elif ! wall_network; then
  log "no lead agent runs, because its network is not walled (CW_LEAD_EGRESS=open runs it without the wall)"
else
  # Without a cgroup, a root watchdog kills the lead's processes once their
  # total passes the cap (lead-memory.sh). A watchdog that cannot run says
  # so and leaves the machine up.
  if cg=$(lead_cgroup); then
    log "the lead's memory is capped at $LEAD_MEMORY_MAX by its cgroup, $cg"
  else
    cg=""
    log "no cgroup v2 memory controller at $CGROUP: the lead's memory is capped at $LEAD_MEMORY_MAX by a watchdog (lead-memory.sh) that kills its processes once their total passes it"
    (
      bash "$HERE/lead-memory.sh" watch "$LEAD_MEMORY_MAX" "$LEAD_UID" ||
        log "the lead's memory is NOT capped: its watchdog exited"
      exec sleep infinity
    ) &
    pids+=($!)
  fi
  (
    child=""
    trap 'if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; fi; exit 0' TERM INT
    while :; do
      (
        if [ -n "$cg" ]; then
          echo "$BASHPID" >"$cg/cgroup.procs" || log "could not join $cg"
        fi
        # First for the kernel's OOM killer, cgroup or not, so a machine that
        # runs out before the cap is reached loses the lead and not the
        # server. Root's write also sets the floor, so the lead cannot lower it.
        echo 1000 >"$PROC/$BASHPID/oom_score_adj" 2>/dev/null ||
          log "could not set the lead's oom_score_adj"
        app="${FLY_APP_NAME:-project}"
        export CW_BOARD_SOCKET="$SOCKETS/$LEAD_BOARD.sock" CW_WORKSPACE_ID="$LEAD_BOARD" \
          CW_AGENT_NAME="${CW_LEAD_AGENT_NAME:-${app#cw-}-lead}" \
          CW_LEAD_ROOT="$LEAD_ROOT" CW_LEAD_TOKEN_LABEL="$LEAD_TOKEN_LABEL" \
          DISABLE_AUTOUPDATER=1 TERM=xterm-256color SHELL=/bin/bash \
          DISABLE_TELEMETRY=1 ENABLE_CLAUDEAI_MCP_SERVERS=false
        # The last two keep Claude Code off the telemetry and connector hosts
        # the proxy refuses. Not CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
        # which turns off Remote Control as well.
        proxy_env
        # shellcheck disable=SC2086
        only_env PATH TERM SHELL CLAUDE_CODE_OAUTH_TOKEN CW_BOARD_SOCKET CW_WORKSPACE_ID \
          CW_AGENT_NAME CW_LEAD_ROOT CW_LEAD_TOKEN_LABEL CW_LEAD_REMOTE_CONTROL \
          CW_LEAD_GITHUB_DEPLOY_KEY \
          DISABLE_AUTOUPDATER DISABLE_TELEMETRY ENABLE_CLAUDEAI_MCP_SERVERS $PROXY_VARS
        # 007, not 077: a file's group is the lead's own group, which holds
        # nobody else, except in the setgid dev folder, where it is
        # cwdevsrc's, so the dev server can read the checkout there.
        umask 007
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

# The project's dev server, when CW_DEV_SERVER_CMD names one: a command line
# run by bash in $DEV_ROOT/work as cwdev, with PATH and the proxy's address, so it
# holds no secret and reaches the board only as the internet does. It must
# bind 127.0.0.1 on a port of its own (the server's, 8787, is refused at
# attach). It is started again when it exits, after a wait that doubles from
# 5s to 60s and resets once a run lasts 5 minutes; it never stops the
# machine. The command is an operator setting (fly secrets set), never a
# value the lead or a board can write.
if [ -n "${CW_DEV_SERVER_CMD:-}" ] && ! wall_network; then
  log "no dev server runs, because its network is not walled (CW_LEAD_EGRESS=open runs it without the wall)"
elif [ -n "${CW_DEV_SERVER_CMD:-}" ]; then
  (
    cmd="$CW_DEV_SERVER_CMD"
    child=""
    trap 'if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; fi; exit 0' TERM INT
    delay=5
    while :; do
      started=$SECONDS
      (
        proxy_env
        # shellcheck disable=SC2086
        only_env PATH $PROXY_VARS
        umask 007
        cd "$DEV_ROOT" || exit 1
        # The folder is made by cwdev, so it is cwdev's and cwdevsrc's.
        run_as cwdev bash -c 'mkdir -p work && cd work && exec bash -c "$1"' dev-server "$cmd"
      ) &
      child=$!
      status=0
      wait "$child" || status=$?
      child=""
      if [ $((SECONDS - started)) -ge 300 ]; then delay=5; fi
      log "the dev server exited ($status); starting it again in ${delay}s"
      sleep "$delay" &
      wait $! || true
      delay=$((delay * 2))
      if [ "$delay" -gt 60 ]; then delay=60; fi
    done
  ) &
  pids+=($!)
fi

# The health check. Fly's own checks reach a machine over its private
# address, and this server listens on loopback only, so the check runs here:
# any HTTP status from loopback is alive (the same rule as the Mac's
# supervisor, docs/architecture/supervisor.md), so the 403 the uid door gives
# root's curl counts as alive. A first bind gets 240s; after
# that, three misses 25s apart exit the machine.
#
# During the first bind it probes every 10s. Three answers in a row mean the
# server stayed up, and the release it runs, if on trial, becomes current. A
# trial that never gets there is rolled back at the next boot.
probe() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -H "host: localhost:$PORT" "http://127.0.0.1:$PORT/api/deploy" || true
}
(
  waited=0
  streak=0
  while [ "$streak" -lt 3 ] && [ "$waited" -lt 240 ]; do
    sleep 10
    waited=$((waited + 10))
    if [ "$(probe)" = 000 ]; then streak=0; else streak=$((streak + 1)); fi
  done
  if [ "$streak" -ge 3 ]; then
    (release_cli promote) || log "could not record the release as current"
  fi
  misses=0
  while :; do
    code=$(probe)
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

# The release check: every CW_RELEASE_POLL_SECONDS (300 unless set), ask the
# channel for a newer signed release. Exit 10 means one is downloaded; this
# loop then exits, so the machine restarts and boots it.
if [ -f "$RELEASE_KEY" ]; then
  (
    poll="${CW_RELEASE_POLL_SECONDS:-300}"
    while :; do
      sleep "$poll"
      status=0
      (release_cli check) || status=$?
      if [ "$status" = 10 ]; then
        log "a newer release is downloaded; restarting the machine to boot it"
        exit 0
      fi
    done
  ) &
  pids+=($!)
else
  log "no release key in the image: this machine does not update itself"
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
