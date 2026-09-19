#!/usr/bin/env bash
# Daily claude-workspaces doc-triage run. Invoked by the
# com.fryanpan.doc-triage launchd job (see scripts/launchd/). Spawns a
# headless Claude run that reads each board's doc listing and pings the owning
# agent (via claude-hive) about the docs and attachment sets idle >24h. It only
# ASKS, and the only thing it asks for is archiving, which is reversible — it
# retires nothing itself and names no destructive verb. The banned list and the
# check behind it are scripts/triage/prompt-audit.ts.
#
# Needs local access to the claude-workspaces server (localhost:8787) and the claude-hive
# network, which is why this runs on the Mac Mini, not as a cloud routine.
# Verified that `claude -p --dangerously-load-development-channels
# server:claude-hive` can reach claude-hive in headless mode.
set -euo pipefail

CLAUDE_BIN="${CLAUDE_BIN:-${HOME}/.local/bin/claude}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROMPT_FILE="${SCRIPT_DIR}/doc-triage-prompt.md"

if [ ! -x "${CLAUDE_BIN}" ]; then
  echo "[doc-triage] claude not found at ${CLAUDE_BIN}" >&2
  exit 1
fi

exec "${CLAUDE_BIN}" -p "$(cat "${PROMPT_FILE}")" \
  --dangerously-load-development-channels server:claude-hive
