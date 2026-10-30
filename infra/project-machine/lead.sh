#!/usr/bin/env bash
# The project's lead agent: one long-lived Claude Code session in a tmux
# session named `lead`, run as the `lead` user. entrypoint.sh starts
# `lead.sh supervise` as that user, with an environment of its own: the
# Claude Code sign-in (CLAUDE_CODE_OAUTH_TOKEN), its board's socket
# (CW_BOARD_SOCKET), the agent's name (CW_AGENT_NAME) and, when the project
# has one, the repo's deploy key (CW_LEAD_GITHUB_DEPLOY_KEY), and none of the
# machine's other secrets. Root starts this again if it exits.
#
#   lead.sh supervise   keep the session running; start it again when it ends
#   lead.sh session     what runs inside tmux: Claude Code itself
#
# A session that ends is started again, resuming its last conversation
# (`--continue`) once there is one, after a wait that doubles from 5s up
# to 50s, so with the 5s check a restart comes within a minute. Six quick
# ends in a row (each under 5 minutes) mean the session cannot start, and
# from then on it is tried every 10 minutes. A session that lasted 5 minutes
# resets the count. Attach to it with (env -i, so root's secrets stay root's):
#
#   fly ssh console --pty --app cw-<project> -C "env -i TERM=xterm-256color setpriv --reuid=lead --regid=lead --init-groups tmux attach -t lead"

HOME="${HOME:?}"
APP=/app
LEAD_ROOT="${CW_LEAD_ROOT:?set by entrypoint.sh}"
WORK="$LEAD_ROOT/work"
SESSION=lead
POLL=5
QUICK=300
CAP=50
GIVE_UP_AFTER=6
SLOW_RETRY=600

log() { echo "[lead] $(date -u +%FT%TZ) $*"; }
# In the background, so a TERM is handled at once rather than after the sleep.
pause() {
  sleep "$1" &
  wait $!
}

# The first run of Claude Code asks about its theme and whether to trust the
# folder, and nobody is at the terminal to answer. The home directory is the
# image's and starts fresh on every boot, so this is written each time.
prepare() {
  mkdir -p "$WORK" "$LEAD_ROOT/claude-projects" "$HOME/.claude" || return 1
  # Transcripts go to the volume, so they survive a restart.
  ln -sfn "$LEAD_ROOT/claude-projects" "$HOME/.claude/projects" || return 1
  if [ ! -e "$HOME/.claude.json" ]; then
    printf '{"hasCompletedOnboarding":true,"projects":{"%s":{"hasTrustDialogAccepted":true}}}\n' \
      "$WORK" >"$HOME/.claude.json" || return 1
  fi
  deploy_key || return 1
}

# The project repo's read-only deploy key, for git over SSH. It arrives
# BASE64 in the environment and is written to a file only this user can
# read; GitHub's host keys are pinned in the image (/etc/ssh/ssh_known_hosts).
deploy_key() {
  [ -n "${CW_LEAD_GITHUB_DEPLOY_KEY:-}" ] || return 0
  local key="$HOME/.ssh/github_deploy_key"
  mkdir -p "$HOME/.ssh" && chmod 0700 "$HOME/.ssh" || return 1
  (umask 077 && printf '%s' "$CW_LEAD_GITHUB_DEPLOY_KEY" | base64 -d >"$key") || return 1
  git config --global core.sshCommand \
    "ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes" || return 1
}

session() {
  cd "$WORK" || exit 1
  # The deploy key is in its file (deploy_key); the session's tools need
  # never see it in their environment.
  unset CW_LEAD_GITHUB_DEPLOY_KEY
  # The plugin is the image's own copy, from the same commit as the server.
  local args=(--plugin-dir "$APP/packages/plugin")
  # A restart, a deploy included, resumes the last conversation in this
  # folder rather than costing the lead its context. Claude Code keeps it
  # under ~/.claude/projects, in a folder named for the working folder with
  # every character but letters and digits turned to -; the first boot has
  # none and starts fresh.
  local convo="$HOME/.claude/projects/${WORK//[^a-zA-Z0-9]/-}"
  if compgen -G "$convo/*.jsonl" >/dev/null; then args+=(--continue); fi
  if [ "${CW_LEAD_REMOTE_CONTROL:-}" = 1 ]; then args+=(--remote-control "$CW_AGENT_NAME"); fi
  exec claude "${args[@]}"
}

supervise() {
  trap 'tmux kill-server 2>/dev/null; exit 0' TERM INT
  local fails=0 started now delay
  while :; do
    started=$(date +%s)
    # A session left by a supervisor that was killed is kept, not doubled.
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      log "session already running; watching it"
    elif prepare &&
      # The command as separate words, so tmux runs it itself rather than
      # through a shell, and the lead's login shell (nologin) is never asked.
      tmux new-session -d -s "$SESSION" -x 200 -y 50 bash "$0" session; then
      log "session started"
    else
      log "the session could not be started"
    fi
    while tmux has-session -t "$SESSION" 2>/dev/null; do pause "$POLL"; done
    now=$(date +%s)
    if [ $((now - started)) -ge "$QUICK" ]; then fails=0; fi
    fails=$((fails + 1))
    if [ "$fails" -ge "$GIVE_UP_AFTER" ]; then
      delay=$SLOW_RETRY
    else
      delay=$((5 << (fails - 1)))
      if [ "$delay" -gt "$CAP" ]; then delay=$CAP; fi
    fi
    log "session ended after $((now - started))s; starting it again in ${delay}s"
    pause "$delay"
  done
}

case "${1:-}" in
  supervise) supervise ;;
  session) session ;;
  *)
    echo "usage: lead.sh supervise|session" >&2
    exit 64
    ;;
esac
