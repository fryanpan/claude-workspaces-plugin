#!/bin/sh
# Launcher for the plugin's hook scripts.
#
# Why this exists: hooks.json used to say `bun run <script>.ts`, which only
# works when bun happens to be on the launching process's PATH. bun installs
# itself to ~/.bun/bin and puts that directory on PATH from ~/.zshrc — so it
# resolves in an interactive shell and nowhere else. A session started any
# other way (launchd, a GUI app, cron, a non-login shell) spawns the hook,
# gets ENOENT, and the hook does nothing. Exactly the same failure the MCP
# launcher next door was written for (see claude-workspaces-mcp.sh), and
# exactly the same shape as the bug the SessionStart hook exists to report:
# configured, inert, and silent about it.
#
# /bin/sh is the one interpreter guaranteed to be present, so it does the
# resolution itself instead of trusting the inherited environment — and when
# it cannot, it SAYS which interpreter it looked for and where, rather than
# exiting quietly.
#
# Usage: /bin/sh claude-workspaces-hook.sh [--tell-agent] <script.ts> [args...]
#
#   --tell-agent  Also write the could-not-resolve report to stdout, as the
#                 SessionStart `additionalContext` envelope. Only for an event
#                 whose stdout reaches the model — SessionStart. On every other
#                 event stdout is a protocol channel or transcript noise, so the
#                 report goes to stderr alone.
#
# Exit code is always 0 on the failure path: a hook that exits non-zero can
# block the turn, and the whole point of this file is that a broken install
# must not cost the agent anything beyond being told about it.

set -u

tell_agent=0
if [ "${1:-}" = "--tell-agent" ]; then
  tell_agent=1
  shift
fi

script="${1:-}"
if [ -z "$script" ]; then
  echo "claude-workspaces-hook: no script path given (expected a hook .ts as \$1)" >&2
  exit 0
fi
shift

bun_root="${BUN_INSTALL:-}"
if [ -z "$bun_root" ] && [ -n "${HOME:-}" ]; then
  bun_root="$HOME/.bun"
fi

find_bun() {
  # 1. Already on PATH (the normal case, and respects an intentional override).
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  # 2. bun's own install root. HOME can be unset in the very environments this
  #    script exists for, so bun_root may be empty — skip rather than abort.
  if [ -n "$bun_root" ] && [ -x "$bun_root/bin/bun" ]; then
    echo "$bun_root/bin/bun"
    return 0
  fi
  # 3. Common fixed locations, in the order a package manager would install them.
  for candidate in \
    /opt/homebrew/bin/bun \
    /usr/local/bin/bun \
    /usr/bin/bun
  do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

bun_bin=$(find_bun) || {
  where="PATH, ${bun_root:-(no BUN_INSTALL and no HOME)}/bin, /opt/homebrew/bin, /usr/local/bin, /usr/bin"
  # The only two characters that could break the hand-built JSON below come
  # from the install path, which this file does not choose — so a path
  # carrying one is dropped rather than escaped.
  #
  # `case` and `echo` are SHELL BUILTINS, deliberately: the first version of
  # this used `tr`, and on a PATH pointing at nothing — which is one of the
  # environments this whole file exists for — `tr: command not found` ate the
  # substitution and the report went out naming no script and no location at
  # all. A diagnostic that needs a working PATH is no diagnostic here. Nothing
  # below this line runs an external command.
  json_safe() {
    case "$1" in
      *'"'* | *'\'*) echo "(omitted: not printable in JSON)" ;;
      *) echo "$1" ;;
    esac
  }
  script_safe=$(json_safe "$script")
  where_safe=$(json_safe "$where")
  report="[claude-workspaces] Plugin hooks are INSTALLED BUT INERT: no bun binary could be found, so $script_safe never ran. Looked in: $where_safe. Every claude-workspaces hook in this session is doing nothing, silently - end-of-turn notes are not reaching any board. Fix: install bun, or launch the session with bun on its PATH, or set BUN_INSTALL to bun's install root."
  echo "$report" >&2
  if [ "$tell_agent" = "1" ]; then
    # Hand-built rather than piped through a JSON tool: jq is not guaranteed
    # present either, and this is the path where nothing can be assumed. The
    # message is fixed text under this file's control and carries no quote,
    # backslash or newline, so it needs no escaping - which is why the sentence
    # above uses a hyphen where it wants an apostrophe.
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$report"
  fi
  exit 0
}

# A seam for the test: prove resolution works without running the hook.
if [ "${CW_HOOK_PRINT_BUN:-}" = "1" ]; then
  echo "$bun_bin"
  exit 0
fi

exec "$bun_bin" run "$script" "$@"
