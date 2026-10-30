#!/bin/sh
# Launcher for the bundled MCP server.
#
# Why this exists: .mcp.json used to say `"command": "node"`, which only works
# when node happens to be on the launching process's PATH. On a machine where
# node comes from nvm, PATH is set up in ~/.zshrc — so it exists in an
# interactive shell and nowhere else. Sessions started any other way (launchd,
# a GUI app, cron, a non-login shell) died with a bare
#
#     Connection failed (ENOENT): Executable not found in $PATH: "node"
#
# and from inside the session the workspace tools were simply absent. Reconnecting
# doesn't help — it reuses the config the session already resolved.
#
# /bin/sh is the one interpreter guaranteed to be present, so it does the
# resolution itself instead of trusting the inherited environment.
#
# WHICH CHILD. The session's child is a relay by default: it carries MCP
# between the session and the server's hosted connector at /mcp, and holds no
# connector of its own (packages/mcp/src/relay/relay-core.ts says why and how).
# In order of preference:
#
#   1. The compiled relay: relay/relay.swift, built on THIS machine by
#      /usr/bin/swiftc into a per-user cache keyed by the source's hash. No
#      binary is ever shipped. The first launch of a new version builds it
#      (measured at 6s) while any other launch waits for that build, up to
#      20s. A build that fails, or a cached binary that no longer runs, is never
#      exec'd: it has to pass `--self-test` first.
#   2. The node relay, mcp/relay.js, run by node or bun, wherever there is
#      no working build: Linux, a Mac without the command line tools, a
#      failed build. Also whenever CW_ACCESS_CLIENT_ID or
#      CW_ACCESS_SECRET_SERVICE is set.
#   3. The full child, mcp/index.js — today's connector in-process — when
#      CW_MCP_RELAY=0 (the rollback lever), or when an identity value is not
#      plain ASCII and so cannot travel as an HTTP header.
#
# A WALLED LEAD (CW_BOARD_SOCKET set, by scripts/lead-sandbox.ts) gets the
# node relay and nothing else: it alone dials a unix socket, and the wall
# refuses every TCP port either other child would use. If the node relay
# cannot run, the launch fails and says so rather than start a child with
# no way to its board.
#
# Usage: /bin/sh claude-workspaces-mcp.sh <path-to-mcp/index.js> [args...]

set -u

bundle="${1:-}"
if [ -z "$bundle" ]; then
  echo "claude-workspaces-mcp: no bundle path given (expected mcp/index.js as \$1)" >&2
  exit 64
fi
shift

# Newest nvm version first: version dirs sort lexically, which is wrong across a
# major boundary (v9 > v10), so compare numerically on each component.
newest_nvm_node() {
  # HOME can be unset in the very environments this script exists for (cron, a
  # sanitized launchd job). Under `set -u` a bare $HOME aborts this function's
  # subshell and prints "HOME: unbound variable" — the fixed locations below are
  # still tried, but that line reads like a crash to whoever is debugging. Default
  # it, and skip the nvm search entirely when there's no root to derive.
  nvm_dir="${NVM_DIR:-}"
  if [ -z "$nvm_dir" ]; then
    [ -n "${HOME:-}" ] || return 1
    nvm_dir="$HOME/.nvm"
  fi
  nvm_root="$nvm_dir/versions/node"
  [ -d "$nvm_root" ] || return 1
  best=''
  best_key=''
  for dir in "$nvm_root"/v*; do
    [ -x "$dir/bin/node" ] || continue
    version="${dir##*/v}"
    # zero-pad each component so a plain string compare orders them correctly
    key=$(echo "$version" | awk -F. '{printf "%05d%05d%05d", $1, $2, $3}')
    if [ -z "$best_key" ] || [ "$key" \> "$best_key" ]; then
      best_key="$key"
      best="$dir/bin/node"
    fi
  done
  [ -n "$best" ] || return 1
  echo "$best"
}

find_node() {
  # 1. Already on PATH (the normal case, and respects an intentional override).
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  # 2. nvm, newest installed version.
  if candidate=$(newest_nvm_node); then
    echo "$candidate"
    return 0
  fi
  # 3. Common fixed locations, in the order a package manager would install them.
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    /snap/bin/node
  do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  # 4. Bun, which runs the bundle too. The README asks for bun and not node, so
  #    a fresh machine may have bun alone — and its installer, like nvm, puts
  #    it on PATH only through ~/.zshrc.
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  bun_home="${BUN_INSTALL:-${HOME:-}/.bun}"
  [ -x "$bun_home/bin/bun" ] && { echo "$bun_home/bin/bun"; return 0; }
  return 1
}

mcp_dir="${bundle%/*}"
[ "$mcp_dir" = "$bundle" ] && mcp_dir=.
relay_src="$mcp_dir/../relay/relay.swift"

# Whether this session runs a relay rather than the full child.
relay_wanted() {
  case "${CW_MCP_RELAY:-1}" in 0|off|false|no) return 1 ;; esac
  # The relay sends these as headers, which carry ASCII; anything else takes
  # the full child, which reads them from its environment.
  for value in "${CW_AGENT_NAME:-}" "${FEEDBACK_AGENT_NAME:-}" \
    "${CW_WORKSPACE_ID:-}" "${FEEDBACK_WORKSPACE_ID:-}" "${PWD:-}"; do
    (LC_ALL=C; case "$value" in *[!\ -~]*) exit 1 ;; esac) || return 1
  done
  return 0
}

# Compile relay.swift into $relay_bin, once per source hash, under a lock.
build_relay() {
  swiftc="${CW_RELAY_SWIFTC:-/usr/bin/swiftc}"
  [ -x "$swiftc" ] || return 1
  # /usr/bin/swiftc is a shim: on a Mac without the command line tools it
  # opens an install dialog rather than failing. xcode-select asks quietly.
  if [ -z "${CW_RELAY_SWIFTC:-}" ]; then
    /usr/bin/xcode-select -p >/dev/null 2>&1 || return 1
  fi
  mkdir -p "$relay_dir" 2>/dev/null || return 1
  # A build that failed is not retried for a day: every launch would pay for
  # the same failure. build.log beside it says why.
  failed="$relay_dir/failed"
  if [ -f "$failed" ]; then
    [ -n "$(find "$failed" -mmin +1440 2>/dev/null)" ] || return 1
    rm -f "$failed"
  fi
  lock="$relay_dir/.building"
  if mkdir "$lock" 2>/dev/null; then
    tmp="$relay_dir/cw-relay.$$"
    if "$swiftc" -O -swift-version 5 -parse-as-library -o "$tmp" "$relay_src" \
        >"$relay_dir/build.log" 2>&1 \
      && "$tmp" --self-test >/dev/null 2>&1; then
      mv -f "$tmp" "$relay_bin"
    else
      rm -f "$tmp"
      : >"$failed"
    fi
    rmdir "$lock" 2>/dev/null
  else
    # Another launch is building. A lock older than five minutes belongs to
    # a build that was killed; clear it for the next launch.
    if [ -n "$(find "$lock" -maxdepth 0 -mmin +5 2>/dev/null)" ]; then
      rmdir "$lock" 2>/dev/null
    fi
    waited=0
    while [ "$waited" -lt 40 ] && [ -d "$lock" ] && [ ! -x "$relay_bin" ]; do
      sleep 0.5
      waited=$((waited + 1))
    done
  fi
  return 0
}

# The compiled relay's path, when a build that passes its self-test exists.
# A board behind Cloudflare Access (CW_ACCESS_CLIENT_ID or
# CW_ACCESS_SECRET_SERVICE set) takes the node relay instead: only it reads
# the Access secret from Keychain, and only it says when half of the pair is
# missing (packages/plugin/hooks/lib/access-headers.ts).
compiled_relay() {
  [ -z "${CW_ACCESS_CLIENT_ID:-}${CW_ACCESS_SECRET_SERVICE:-}" ] || return 1
  [ -f "$relay_src" ] || return 1
  [ "$(uname -s 2>/dev/null)" = "Darwin" ] || return 1
  cache="${CW_RELAY_CACHE_DIR:-}"
  if [ -z "$cache" ]; then
    [ -n "${HOME:-}" ] || return 1
    cache="$HOME/Library/Caches/claude-workspaces/relay"
  fi
  hash=$(/sbin/md5 -q "$relay_src" 2>/dev/null) || return 1
  # The suffix names the compiler flags, so changing them rebuilds.
  relay_dir="$cache/$hash-o5"
  relay_bin="$relay_dir/cw-relay"
  [ -x "$relay_bin" ] || build_relay
  [ -x "$relay_bin" ] && "$relay_bin" --self-test >/dev/null 2>&1 || return 1
  echo "$relay_bin"
}

board_socket="${CW_BOARD_SOCKET:-}"
if [ -n "$board_socket" ] && ! relay_wanted; then
  echo "claude-workspaces-mcp: CW_BOARD_SOCKET is set, so only the node relay can reach the board, and it is off (CW_MCP_RELAY=0, or an identity value that is not plain ASCII)." >&2
  exit 64
fi

if relay_wanted; then
  plugin_json="$mcp_dir/../.claude-plugin/plugin.json"
  if [ -f "$plugin_json" ]; then
    CW_RELAY_PLUGIN_VERSION=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([0-9.]*\)".*/\1/p' "$plugin_json" | head -n 1)
    export CW_RELAY_PLUGIN_VERSION
  fi
  if [ -z "$board_socket" ] && relay_bin=$(compiled_relay); then
    [ "${CW_MCP_PRINT_CHILD:-}" = "1" ] && { echo "compiled $relay_bin"; exit 0; }
    exec "$relay_bin"
  fi
fi

node_bin=$(find_node) || {
  echo "claude-workspaces-mcp: could not find a node or bun binary." >&2
  echo "  Looked on PATH, in \${NVM_DIR:-\$HOME/.nvm}/versions/node, in" >&2
  echo "  /opt/homebrew/bin, /usr/local/bin, /usr/bin, /snap/bin, and in \${BUN_INSTALL:-\$HOME/.bun}/bin." >&2
  echo "  Install node or bun, or put one on the PATH the session is launched with." >&2
  exit 127
}

# A seam for the test: prove resolution works without starting a stdio server.
if [ "${CW_MCP_PRINT_NODE:-}" = "1" ]; then
  echo "$node_bin"
  exit 0
fi

if relay_wanted && [ -f "$mcp_dir/relay.js" ]; then
  [ "${CW_MCP_PRINT_CHILD:-}" = "1" ] && { echo "node-relay"; exit 0; }
  exec "$node_bin" "$mcp_dir/relay.js"
fi
if [ -n "$board_socket" ]; then
  echo "claude-workspaces-mcp: CW_BOARD_SOCKET is set and $mcp_dir/relay.js is missing, so nothing can reach the board." >&2
  exit 64
fi
[ "${CW_MCP_PRINT_CHILD:-}" = "1" ] && { echo "full"; exit 0; }
exec "$node_bin" "$bundle" "$@"
