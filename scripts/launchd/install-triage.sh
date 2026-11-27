#!/usr/bin/env bash
# Install the daily claude-workspaces doc-triage job as a launchd LaunchAgent.
#
# Fires once a day (09:00 local by default — edit the plist template's
# StartCalendarInterval and re-run) and spawns a headless Claude run that pings
# each owning agent about its docs and attachment sets idle >24h. It only ASKS
# owners to archive them — reversibly — and retires nothing itself.
#
# Idempotent: re-run after editing the template or the prompt. Uninstall with:
#   launchctl bootout gui/$(id -u)/com.fryanpan.doc-triage
set -euo pipefail

PATH="/usr/bin:/bin:/usr/sbin:${PATH:-}"

LABEL="com.fryanpan.doc-triage"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
TEMPLATE="${SCRIPT_DIR}/${LABEL}.plist.template"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs"

# Same bootout-then-bootstrap window as install.sh, so the same helpers.
# shellcheck source=scripts/launchd/bootstrap-retry.sh
. "${SCRIPT_DIR}/bootstrap-retry.sh"
# bun resolution and the template fill, sourced so a test can run them.
# shellcheck source=scripts/launchd/render-triage-plist.sh
. "${SCRIPT_DIR}/render-triage-plist.sh"

# Resolve the claude CLI. launchd doesn't run a login shell, so we need an
# absolute path. ~/.local/bin/claude is the official installer's location.
if [ -x "${HOME}/.local/bin/claude" ]; then
    CLAUDE_BIN="${HOME}/.local/bin/claude"
elif command -v claude >/dev/null 2>&1; then
    CLAUDE_BIN="$(command -v claude)"
else
    echo "error: claude CLI not found (looked in ~/.local/bin and PATH)." >&2
    exit 1
fi
CLAUDE_DIR="$(dirname "${CLAUDE_BIN}")"

# The headless run's MCP servers start with `bun`, and launchd's PATH is only
# what the plist names. Fail here, at install, rather than every morning.
BUN_BIN="$(resolve_bun_bin)" || exit 1
BUN_DIR="$(dirname "${BUN_BIN}")"

echo "[install-triage] label:  ${LABEL}"
echo "[install-triage] repo:   ${REPO_DIR}"
echo "[install-triage] claude: ${CLAUDE_BIN}"
echo "[install-triage] bun:    ${BUN_BIN}"
echo "[install-triage] plist:  ${PLIST_DEST}"

DOMAIN="gui/$(id -u)"

if "${LAUNCHCTL}" print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    echo "[install-triage] existing job found — bootout first"
    "${LAUNCHCTL}" bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
    wait_for_bootout "${DOMAIN}/${LABEL}"
fi

mkdir -p "$(dirname "${PLIST_DEST}")" "${LOG_DIR}"

render_triage_plist "${TEMPLATE}" > "${PLIST_DEST}"

if ! bootstrap_with_retry "${DOMAIN}" "${PLIST_DEST}"; then
    exit 3
fi

echo "[install-triage] loaded. Next fire: 09:00 local (per StartCalendarInterval)."
echo "[install-triage] Run now to test:  launchctl kickstart -k ${DOMAIN}/${LABEL}"
echo "[install-triage] Logs: ${LOG_DIR}/${LABEL}.{out,err}.log"
echo "[install-triage] Uninstall: launchctl bootout ${DOMAIN}/${LABEL}"
