#!/bin/bash
# Uninstall the retired keeper from the Mac (docs/process/keeper.md, "Uninstall").
#
#   sudo bash scripts/keeper-uninstall.sh             do it
#   bash scripts/keeper-uninstall.sh --dry-run        print each step, change nothing
#
# Run from Bryan's own account with sudo: the launchd jobs and the keeper's
# folder need root, and the Keychain, settings.json, fly and gh steps run as
# the account that called sudo ($SUDO_USER). Every step is safe to repeat; a
# step whose target is already gone says so and the script carries on.
#
# One step stays in the browser: deleting the "claude-workspaces keeper" token
# in Cloudflare's dashboard. The script prints it at the end.
set -u

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

if [ "$DRY" = 0 ] && [ "$(id -u)" != 0 ]; then
  echo "Run it with sudo: sudo bash $0" >&2
  exit 1
fi
U="${SUDO_USER:-$(id -un)}"
if [ "$DRY" = 0 ] && [ "$U" = root ]; then
  echo "Run it with sudo from your own account, not as root." >&2
  exit 1
fi
H="$(dscl . -read "/Users/$U" NFSHomeDirectory | awk '{print $2}')"
CW="$H/Library/Application Support/claude-workspaces"
BUN="$CW/bin/bun"
PLIST_PROD="$H/Library/LaunchAgents/com.fryanpan.claude-workspaces.plist"
SETTINGS="$H/.claude/settings.json"

FAILED=0
# Run as the account that called sudo (or as itself, without sudo, in a dry run).
as_user() {
  if [ "$(id -u)" = 0 ]; then sudo -u "$U" HOME="$H" "$@"; else "$@"; fi
}
step() { printf '\n== %s\n' "$*"; }
run() {
  # run <as: root|user> <command...>
  local who="$1"
  shift
  if [ "$DRY" = 1 ]; then
    printf '  would run (%s): %s\n' "$who" "$*"
    return 0
  fi
  if [ "$who" = user ]; then
    as_user "$@"
  else
    "$@"
  fi
}
# A step that finds its target already gone prints this rather than failing.
gone() { echo "  already gone: $*"; }

step "1. Stop the keeper's two launchd jobs and remove their plists"
for job in com.claude-workspaces.keeper com.claude-workspaces.keeper-port; do
  if launchctl print "system/$job" >/dev/null 2>&1; then
    run root launchctl bootout "system/$job" || FAILED=1
  else
    gone "system/$job"
  fi
  f="/Library/LaunchDaemons/$job.plist"
  if [ -e "$f" ]; then run root rm -f "$f" || FAILED=1; else gone "$f"; fi
done

step "2. Remove the keeper's release, binaries and token store, and its caller token"
if [ -e /Users/cw-relay/keeper ]; then
  run root rm -rf /Users/cw-relay/keeper || FAILED=1
else
  gone /Users/cw-relay/keeper
fi
if [ -e "$CW/keeper-caller-token" ]; then
  run user rm -f "$CW/keeper-caller-token" || FAILED=1
else
  gone "$CW/keeper-caller-token"
fi

step "3. Remove CW_KEEPER_URL from prod's plist and from ~/.claude/settings.json"
if /usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:CW_KEEPER_URL' "$PLIST_PROD" >/dev/null 2>&1; then
  run user /usr/libexec/PlistBuddy -c 'Delete :EnvironmentVariables:CW_KEEPER_URL' "$PLIST_PROD" || FAILED=1
else
  gone "CW_KEEPER_URL in $PLIST_PROD"
fi
if [ -f "$SETTINGS" ] && grep -q '"CW_KEEPER_URL"' "$SETTINGS"; then
  # Only the one key is removed; the file keeps every other setting.
  run user "$BUN" -e '
    const f = process.argv[1];
    const j = JSON.parse(await Bun.file(f).text());
    if (j.env) delete j.env.CW_KEEPER_URL;
    await Bun.write(f, JSON.stringify(j, null, 2) + "\n");
  ' "$SETTINGS" || FAILED=1
else
  gone "CW_KEEPER_URL in $SETTINGS"
fi

step "4. Delete the keeper's old Keychain entries"
for args in "-s cloudflare-api-token" \
  "-a claude-workspaces -s claude-workspaces-secret.cloudflare-api-token" \
  "-a claude-workspaces -s claude-workspaces-secret.fly-org-token"; do
  # shellcheck disable=SC2086 # the account and service flags split on purpose
  if as_user security find-generic-password $args >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    if [ "$DRY" = 1 ]; then
      run user security delete-generic-password $args
    else
      as_user security delete-generic-password $args >/dev/null || FAILED=1
    fi
    [ "$DRY" = 1 ] || echo "  deleted: $args"
  else
    gone "Keychain entry $args"
  fi
done

step "5. Revoke the Fly token named keeper"
FLY="$(as_user bash -lc 'command -v fly' 2>/dev/null || echo /opt/homebrew/bin/fly)"
# The table's columns are split by "│": ID, NAME, CREATED BY, EXPIRES AT.
IDS="$(as_user "$FLY" tokens list -o fryanpan-workspaces 2>/dev/null |
  awk -F'│' 'NR > 2 { id = $1; n = $2; gsub(/^ +| +$/, "", id); gsub(/^ +| +$/, "", n); if (n == "keeper") print id }')"
if [ -z "$IDS" ]; then
  gone "Fly token named keeper (or fly could not list tokens: check with fly tokens list -o fryanpan-workspaces)"
else
  for id in $IDS; do run user "$FLY" tokens revoke "$id" || FAILED=1; done
fi

step "6. Check"
if [ "$DRY" = 1 ]; then
  echo "  skipped in a dry run"
elif launchctl print system/com.claude-workspaces.keeper >/dev/null 2>&1; then
  echo "  FAIL: the keeper job is still loaded"
  FAILED=1
else
  echo "  ok: launchd has no keeper job"
fi
if [ "$DRY" = 0 ]; then
  if [ -e /Users/cw-relay/keeper ]; then
    echo "  FAIL: /Users/cw-relay/keeper still exists"
    FAILED=1
  else
    echo "  ok: the keeper folder is gone"
  fi
fi

cat <<'EOF'

== Last step, in the browser
Cloudflare dashboard > My Profile > API Tokens: delete the token named
"claude-workspaces keeper".
EOF

if [ "$FAILED" = 1 ]; then
  echo
  echo "Some steps failed (see above). Fix them and run the script again; finished steps are skipped."
  exit 1
fi
echo
if [ "$DRY" = 1 ]; then echo "Dry run finished; nothing changed."; else echo "Keeper uninstalled."; fi
