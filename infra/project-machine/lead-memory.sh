#!/usr/bin/env bash
# The lead's memory ceiling where the machine has no cgroup v2 memory
# controller to enforce one (entrypoint.sh, lead_cgroup). Run as root.
#
#   lead-memory.sh bytes <size>          1280M, 2G, 512K or a byte count, in bytes
#   lead-memory.sh total <uid>           the memory every process of <uid> holds, in bytes
#   lead-memory.sh watch <size> <uid>    every CW_LEAD_MEMORY_POLL seconds (2 unless
#                                        set), kill every process of <uid> once
#                                        their total passes <size>
#
# A process's memory is its PSS from /proc/<pid>/smaps_rollup, so a page the
# lead's processes share (the claude binary, a library) counts once across
# them, divided among its users; a kernel without smaps_rollup gives VmRSS
# from /proc/<pid>/status instead, which counts a shared page in every process
# and so kills sooner, never later. A process belongs to <uid> when its real
# or effective uid is <uid>, so a child the lead starts is counted whatever it
# is called, and a lead process cannot leave the count except by becoming
# another user, which it has no way to do.
#
# Killing is every process of the user at once, with SIGKILL: the session,
# its tools and the lead's own supervisor. Root's loop in entrypoint.sh
# starts the supervisor again 10s later, and the session resumes its last
# conversation (lead.sh). Between two polls the lead can outgrow the cap;
# entrypoint.sh also sets the lead's oom_score_adj to 1000, so if the machine
# itself runs out first the kernel kills the lead before the server.
set -uo pipefail

PROC="${CW_MACHINE_PROC_ROOT:-/proc}"
# Only so a test can watch a kill without sending one.
KILL="${CW_LEAD_MEMORY_KILL:-kill}"

log() { echo "[machine] $(date -u +%FT%TZ) $*"; }

bytes() {
  local v=$1
  if [[ $v =~ ^([0-9]+)([KkMmGg]?)$ ]]; then
    local n=${BASH_REMATCH[1]}
    case ${BASH_REMATCH[2]} in
      K | k) echo $((n * 1024)) ;;
      M | m) echo $((n * 1024 * 1024)) ;;
      G | g) echo $((n * 1024 * 1024 * 1024)) ;;
      *) echo "$n" ;;
    esac
  else
    return 1
  fi
}

# A byte count as the cap is usually written: M, or K under a megabyte.
human() {
  if [ "$1" -ge 1048576 ]; then echo "$(($1 / 1048576))M"; else echo "$(($1 / 1024))K"; fi
}

# Prints "<total bytes> <pid> <pid> ..." for every process of uid $1.
scan() {
  local want=$1 total=0 pids=() d pid line uid_real uid_eff kb
  for d in "$PROC"/[0-9]*; do
    pid=${d##*/}
    [ -r "$d/status" ] || continue
    uid_real="" uid_eff="" kb=""
    while IFS= read -r line; do
      case $line in
        Uid:*)
          read -r _ uid_real uid_eff _ <<<"$line"
          ;;
        VmRSS:*)
          read -r _ kb _ <<<"$line"
          ;;
      esac
    done 2>/dev/null <"$d/status"
    [ "$uid_real" = "$want" ] || [ "$uid_eff" = "$want" ] || continue
    if [ -r "$d/smaps_rollup" ]; then
      while IFS= read -r line; do
        case $line in Pss:*) read -r _ kb _ <<<"$line" ;; esac
      done 2>/dev/null <"$d/smaps_rollup"
    fi
    total=$((total + ${kb:-0} * 1024))
    pids+=("$pid")
  done
  echo "$total ${pids[*]}"
}

watch() {
  local limit uid=$2 poll="${CW_LEAD_MEMORY_POLL:-2}" cap total pids
  limit=$(bytes "$1") || {
    log "the lead's memory is NOT capped: $1 is not a size"
    exit 2
  }
  if ! [ -r "$PROC/self/status" ] && ! compgen -G "$PROC/[0-9]*/status" >/dev/null; then
    log "the lead's memory is NOT capped: cannot read $PROC"
    exit 2
  fi
  cap=$(human "$limit")
  while :; do
    read -r total pids <<<"$(scan "$uid")"
    if [ "$total" -gt "$limit" ] && [ -n "$pids" ]; then
      log "the lead's processes hold $(human "$total"), over their $cap cap: killing all $(wc -w <<<"$pids" | tr -d ' ') of them"
      # shellcheck disable=SC2086
      $KILL -KILL $pids 2>/dev/null || true
    fi
    sleep "$poll"
  done
}

case "${1:-}" in
  bytes) bytes "${2:-}" ;;
  total)
    read -r t _ <<<"$(scan "${2:?uid}")"
    echo "$t"
    ;;
  watch) watch "${2:?size}" "${3:?uid}" ;;
  *)
    echo "usage: lead-memory.sh bytes <size> | total <uid> | watch <size> <uid>" >&2
    exit 64
    ;;
esac
