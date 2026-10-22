#!/usr/bin/env bash
# The project machine's one process tree: the board server on loopback, the
# Cloudflare Tunnel it is reached through, a loopback health check, and the
# backup loop. If any of them exits, everything stops and the machine exits,
# and Fly's restart policy starts it again.
#
# Runs as root only long enough to give the volume to the `cw` user (a fresh
# Fly volume mounts owned by root), then re-executes itself as `cw`.
set -euo pipefail

DATA_ROOT=/data
export CW_DATA_DIR="${CW_DATA_DIR:-$DATA_ROOT/cw}"
PORT=8787
APP=/app

if [ "$(id -u)" = 0 ]; then
  mkdir -p "$CW_DATA_DIR"
  chown cw:cw "$DATA_ROOT" "$CW_DATA_DIR"
  exec setpriv --reuid=cw --regid=cw --init-groups -- "$0" "$@"
fi

# setpriv keeps root's environment; give the server cw's own home.
export HOME=/home/cw USER=cw

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

# Each child gets only the secrets it uses. The server never sees the tunnel
# token or the bucket credential.
SECRETS=(CLOUDFLARE_TUNNEL_TOKEN BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY)
without_secrets() {
  local unset=()
  for s in "${SECRETS[@]}"; do unset+=(-u "$s"); done
  env "${unset[@]}" "$@"
}

pids=()

without_secrets bun run "$APP/packages/server/src/bin.ts" \
  --port "$PORT" --host 127.0.0.1 --no-port-walk \
  --data-dir "$CW_DATA_DIR" \
  --widget-dist "$APP/packages/widget/dist" \
  --workspaces-app-dist "$APP/packages/workspaces-app/dist" &
pids+=($!)

# cloudflared reads TUNNEL_TOKEN from its environment; ingress (the one
# address to http://localhost:8787) is set on the tunnel in Cloudflare.
# A quick tunnel (CW_TUNNEL_MODE=quick) needs no Cloudflare account: it gets
# a random trycloudflare.com address, printed in the machine's logs, and is
# for a test machine only. Its visitors carry cf-ray and no Access identity,
# so the server treats them as the internet and lets them reach nothing.
if [ "$CW_TUNNEL_MODE" = quick ]; then
  env -i PATH="$PATH" HOME="$HOME" \
    cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" &
else
  env -i PATH="$PATH" HOME="$HOME" TUNNEL_TOKEN="$CLOUDFLARE_TUNNEL_TOKEN" \
    cloudflared tunnel --no-autoupdate run &
fi
pids+=($!)

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
      env -u CLOUDFLARE_TUNNEL_TOKEN bun run "$APP/infra/project-machine/backup.ts" ||
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
