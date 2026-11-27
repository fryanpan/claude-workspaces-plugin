#!/usr/bin/env bash
# Resolves bun and renders the doc-triage LaunchAgent plist for
# scripts/launchd/install-triage.sh.
#
# It lives in its own sourceable file so a test can run both functions and
# read the rendered plist. install-triage.sh itself cannot run in a test: it
# boots the job out of, and back into, the real launchd domain.

# resolve_bun_bin
#   Prints the absolute path of bun, or fails with a message on stderr.
#   launchd runs no login shell, so the job's PATH holds only what the plist
#   names. The headless run spawns MCP servers (claude-hive among them) with
#   `bun`, and without bun's directory on PATH they fail with "Executable not
#   found in $PATH: bun".
resolve_bun_bin() {
    if command -v bun >/dev/null 2>&1; then
        command -v bun
    elif [ -x "${HOME}/.bun/bin/bun" ]; then
        echo "${HOME}/.bun/bin/bun"
    else
        echo "error: bun not found (looked on PATH and in ~/.bun/bin)." >&2
        echo "error: the triage job's MCP servers run on bun; install it first." >&2
        return 1
    fi
}

# render_triage_plist <template>
#   Prints the filled-in plist on stdout, from the variables install-triage.sh
#   sets: REPO_DIR, CLAUDE_BIN, CLAUDE_DIR, BUN_DIR, HOME and LOG_DIR.
render_triage_plist() {
    sed \
        -e "s|{{REPO_DIR}}|${REPO_DIR}|g" \
        -e "s|{{CLAUDE_BIN}}|${CLAUDE_BIN}|g" \
        -e "s|{{CLAUDE_DIR}}|${CLAUDE_DIR}|g" \
        -e "s|{{BUN_DIR}}|${BUN_DIR}|g" \
        -e "s|{{HOME_DIR}}|${HOME}|g" \
        -e "s|{{LOG_DIR}}|${LOG_DIR}|g" \
        "$1"
}
