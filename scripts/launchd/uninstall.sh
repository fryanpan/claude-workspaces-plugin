#!/usr/bin/env bash
# Stop and remove the claude-workspaces launchd service.

set -euo pipefail

# Same default and override as install.sh: pass the CW_LAUNCHD_LABEL you
# installed with.
LABEL="${CW_LAUNCHD_LABEL:-com.fryanpan.claude-workspaces}"
case "${LABEL}" in
    *[!A-Za-z0-9._-]* | "" | .* )
        echo "error: CW_LAUNCHD_LABEL must be a reverse-DNS name (letters, digits, '.', '-', '_')." >&2
        exit 1
        ;;
esac
DOMAIN="gui/$(id -u)"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [ ! -f "${PLIST_DEST}" ]; then
    echo "[uninstall] plist not present at ${PLIST_DEST} — nothing to do."
    exit 0
fi

echo "[uninstall] bootout ${DOMAIN}/${LABEL}"
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true

echo "[uninstall] removing ${PLIST_DEST}"
rm -f "${PLIST_DEST}"

echo "[uninstall] done. Logs preserved at ${HOME}/Library/Logs/${LABEL}.{out,err}.log"
