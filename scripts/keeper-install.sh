#!/bin/zsh -f
# Install or update the keeper: sections 1 to 3 of docs/process/keeper.md as
# one script. Every step checks what is already there and skips or repairs
# it, so after a crash or a fix you run it again from the top.
#
# Run it as yourself, never as root, from GitHub rather than from a checkout
# (agents can write the checkout), in a shell that reads no startup files:
#
#   /bin/zsh -f -c "$(/usr/bin/curl -fsSL https://raw.githubusercontent.com/fryanpan/claude-workspaces-plugin/main/scripts/keeper-install.sh)"
#
# It asks for your admin password once (sudo), asks you to confirm the commit
# it is about to install, and stops at the first step that fails, saying
# which one. It never boots out the port job, never deletes anything, and
# creates no users: cw-relay must exist (docs/process/mac-lead-users.md).
#
#   KEEPER_BUN=/path/to/bun KEEPER_FLY=/path/to/fly   where to copy bun and fly from,
#                                                      the first time or with KEEPER_UPDATE_BINARIES=1
#   KEEPER_YES=1                                       install the commit GitHub names without asking

set -eu
setopt pipefail 2>/dev/null || true
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

RELAY=cw-relay
K=/Users/$RELAY/keeper
URL=https://github.com/fryanpan/claude-workspaces-plugin.git
D=/Library/LaunchDaemons
PORT_JOB=com.claude-workspaces.keeper-port
KEEPER_JOB=com.claude-workspaces.keeper
SUDO=/usr/bin/sudo

step() { print -r -- ""; print -r -- "== $*"; }
ok() { print -r -- "   ok: $*"; }
stop() { print -r -- ""; print -r -- "STOP: $*"; print -r -- "Nothing after this step ran. Fix it and run the script again."; exit 1; }
as_relay() { $SUDO -H -u $RELAY "$@"; }
keeper() {
  as_relay env CW_KEEPER_DIR="$K/state" CW_KEEPER_FLY_BIN="$K/bin/fly" \
    "$K/bin/bun" "$K/app/packages/server/src/keeper/keeper-bin.ts" "$@"
}
loaded() { $SUDO launchctl print "system/$1" >/dev/null 2>&1; }

step "0. Preflight"
[ "$(id -u)" != 0 ] || stop "run this as yourself, not as root; it uses sudo where it needs to"
id "$RELAY" >/dev/null 2>&1 || stop "the macOS user $RELAY does not exist; create it with docs/process/mac-lead-users.md first"
$SUDO -v || stop "sudo did not accept the password"
ok "running as $(id -un), $RELAY exists, sudo works"

step "1. Folders"
as_relay mkdir -p "$K/bin" "$K/state" "$K/releases" "$K/run"
as_relay chmod 700 "$K/state" "$K/run"
ok "$K/{bin,state,releases,run}"

step "2. bun and fly, copied so only $RELAY can change them"
find_bin() {
  local want=$1 override=$2 c
  if [ -n "$override" ]; then print -r -- "$override"; return; fi
  for c in "${@:3}"; do [ -x "$c" ] && { print -r -- "$c"; return; }; done
  print -r -- ""
}
copy_bin() {
  local name=$1 src=$2 dst="$K/bin/$1"
  if as_relay test -x "$dst" && [ "${KEEPER_UPDATE_BINARIES:-0}" != 1 ]; then
    ok "$dst is installed (KEEPER_UPDATE_BINARIES=1 replaces it)"
    return
  fi
  [ -n "$src" ] || stop "no $name found; set KEEPER_$(print -r -- $name | tr a-z A-Z)=/path/to/$name"
  src=$(/bin/realpath "$src")
  if as_relay test -x "$dst" && $SUDO cmp -s "$src" "$dst"; then ok "$dst already matches $src"; return; fi
  $SUDO install -o $RELAY -m 755 "$src" "$dst"
  ok "copied $src to $dst"
}
copy_bin bun "$(find_bin bun "${KEEPER_BUN:-}" "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun)"
copy_bin fly "$(find_bin fly "${KEEPER_FLY:-}" "$HOME/.fly/bin/flyctl" /opt/homebrew/bin/flyctl /usr/local/bin/flyctl)"

step "3. The keeper's own clone"
if as_relay git -C "$K/src" rev-parse --git-dir >/dev/null 2>&1; then
  ok "$K/src is a clone"
else
  if as_relay test -e "$K/src"; then
    aside="$K/src.broken-$(date +%Y%m%d%H%M%S)"
    as_relay mv "$K/src" "$aside"
    print -r -- "   moved a half-made $K/src aside to $aside"
  fi
  as_relay git clone --quiet --no-checkout "$URL" "$K/src"
  ok "cloned $URL"
fi

step "4. The release, checked against GitHub"
as_relay git -C "$K/src" fetch --quiet origin main
SHA=$(as_relay git -C "$K/src" rev-parse FETCH_HEAD)
LIVE=$(as_relay git ls-remote "$URL" refs/heads/main | cut -f1)
[ -n "$SHA" ] && [ "$SHA" = "$LIVE" ] || stop "fetched $SHA, but GitHub says main is $LIVE"
REL="$K/releases/$SHA"
CURRENT=$(as_relay readlink "$K/app" 2>/dev/null || true)
CHANGED=0
if [ "$CURRENT" = "$REL" ] && as_relay test -f "$REL/.keeper-release-complete"; then
  ok "already on $SHA"
else
  print -r -- "   GitHub's main is $SHA. Check it is the merge commit you meant to ship"
  print -r -- "   (GitHub shows it on the merged pull request)."
  if [ "${KEEPER_YES:-0}" != 1 ]; then
    print -n -- "   Install $SHA? [y/N] "
    read -r answer
    [ "$answer" = y ] || [ "$answer" = Y ] || stop "you did not confirm $SHA"
  fi
  if ! as_relay test -f "$REL/.keeper-release-complete"; then
    if as_relay test -e "$REL"; then
      aside="$K/releases/.unfinished-$SHA-$(date +%Y%m%d%H%M%S)"
      as_relay mv "$REL" "$aside"
      print -r -- "   moved an unfinished release aside to $aside"
    fi
    PART="$K/releases/.partial-$SHA"
    if as_relay test -e "$PART"; then as_relay mv "$PART" "$PART.old-$(date +%Y%m%d%H%M%S)"; fi
    as_relay mkdir "$PART"
    as_relay sh -c 'git -C "$1" archive "$2" | tar -x -C "$3"' _ "$K/src" "$SHA" "$PART"
    as_relay touch "$PART/.keeper-release-complete"
    as_relay mv "$PART" "$REL"
  fi
  as_relay ln -sfn "$REL" "$K/app"
  CHANGED=1
  ok "installed $SHA"
fi

step "5. The keeper's own check"
CHECK=$(keeper check 2>&1) || true
print -r -- "$CHECK" | sed 's/^/   /'
print -r -- "$CHECK" | grep -q '^unsafe:' && stop "the check found a path another user could change (the unsafe: lines above)"
print -r -- "$CHECK" | tail -1 | grep -q '^store: ok' || stop "the store check did not end with store: ok"
PASSKEYS=$(print -r -- "$CHECK" | tail -1 | sed -n 's/^store: ok, \([0-9]*\) passkeys.*/\1/p')
ok "no unsafe paths, store ok"

step "6. The port job, which holds the keeper's address from boot"
NEW_PORT_JOB=0
if loaded $PORT_JOB; then
  ok "$PORT_JOB is loaded; it is never booted out"
else
  # One root step draws the port, writes both plists readable only by root,
  # and loads the port job, so nothing prints the port before it is held.
  $SUDO /bin/sh -c '
    set -e; umask 077; K="$1"; D="$2"
    keeper() { /usr/bin/sudo -H -u cw-relay env CW_KEEPER_DIR="$K/state" CW_KEEPER_FLY_BIN="$K/bin/fly" \
      "$K/bin/bun" "$K/app/packages/server/src/keeper/keeper-bin.ts" "$@"; }
    keeper plist port > "$D/com.claude-workspaces.keeper-port.plist"
    keeper plist keeper > "$D/com.claude-workspaces.keeper.plist"
    chown root:wheel "$D"/com.claude-workspaces.keeper-port.plist "$D"/com.claude-workspaces.keeper.plist
    launchctl bootstrap system "$D/com.claude-workspaces.keeper-port.plist"
  ' sh "$K" "$D" || stop "loading the port job failed. If bootstrap said the address is in use, something took the port in the second since it was drawn: find out what before running again"
  NEW_PORT_JOB=1
  ok "loaded $PORT_JOB"
fi
PORT=$(keeper port)
print -r -- "$PORT" | grep -qE '^[0-9]+$' || stop "keeper port printed '$PORT', not a number"
ok "the keeper's port is $PORT"

PORT_PLIST=$($SUDO cat "$D/$PORT_JOB.plist")
for want in /usr/bin/nc -U "$K/run/keeper.sock" 127.0.0.1 ::1 "$PORT"; do
  print -r -- "$PORT_PLIST" | grep -qF -- "$want" || stop "the port plist does not name $want"
done
ok "the port plist names nc, the socket, 127.0.0.1 and ::1 on $PORT"
if [ "$(keeper plist port)" != "$PORT_PLIST" ]; then
  print -r -- "   NOTE: this release would write a different port plist. Reloading it frees the"
  print -r -- "   address for a moment, so the script leaves it; see \"Updating the keeper\" in keeper.md."
fi

step "7. The keeper job"
WANT=$(keeper plist keeper)
HAVE=$($SUDO cat "$D/$KEEPER_JOB.plist" 2>/dev/null || true)
for want in "$K/bin/bun" keeper-bin.ts CW_KEEPER_SOCKET "$K/run/keeper.sock" CW_KEEPER_PORT "$PORT"; do
  print -r -- "$WANT" | grep -qF -- "$want" || stop "the keeper plist this release writes does not name $want"
done
PLIST_CHANGED=0
if [ "$WANT" != "$HAVE" ]; then
  $SUDO /bin/sh -c 'umask 077; cat > "$1"; chown root:wheel "$1"' sh "$D/$KEEPER_JOB.plist" <<<"$WANT"
  PLIST_CHANGED=1
  ok "wrote $D/$KEEPER_JOB.plist"
fi
if ! loaded $KEEPER_JOB; then
  $SUDO launchctl bootstrap system "$D/$KEEPER_JOB.plist" || stop "launchctl bootstrap of the keeper job failed"
  ok "loaded $KEEPER_JOB"
elif [ $PLIST_CHANGED = 1 ]; then
  $SUDO launchctl bootout "system/$KEEPER_JOB" || true
  $SUDO launchctl bootstrap system "$D/$KEEPER_JOB.plist" || stop "reloading the keeper job failed"
  ok "reloaded $KEEPER_JOB with its new plist"
elif [ $CHANGED = 1 ]; then
  $SUDO launchctl kickstart -k "system/$KEEPER_JOB" || stop "restarting the keeper job failed"
  ok "restarted $KEEPER_JOB on the new release"
else
  ok "$KEEPER_JOB is loaded and current"
fi

step "8. Prove it answers"
LISTEN=$($SUDO lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true)
print -r -- "$LISTEN" | sed 's/^/   /'
[ "$(print -r -- "$LISTEN" | awk '$1=="launchd" && $2==1' | grep -cE '127\.0\.0\.1:|\[::1\]:')" = 2 ] \
  || stop "expected two listeners on $PORT, 127.0.0.1 and [::1], both owned by launchd (pid 1)"
ok "launchd holds 127.0.0.1:$PORT and [::1]:$PORT"
seen=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if /usr/bin/curl -s "http://localhost:$PORT/" | grep -q 'Waiting for your passkey'; then seen=1; break; fi
  sleep 1
done
[ $seen = 1 ] || stop "the keeper's page did not answer on http://localhost:$PORT/ within 10 s; read: $SUDO launchctl print system/$KEEPER_JOB"
ok "the keeper's page answers"

step "9. Your passkey"
if [ $NEW_PORT_JOB = 1 ]; then
  print -r -- "   The port job is new, so FIRST clear localhost's site data in every browser on this Mac"
  print -r -- "   (Chrome: Settings > Privacy and security > Site data, search localhost, delete."
  print -r -- "    Safari: Settings > Privacy > Manage Website Data > localhost > Remove)."
fi
if [ "${PASSKEYS:-0}" -gt 0 ] 2>/dev/null; then
  ok "$PASSKEYS passkey(s) registered already"
else
  keeper enroll | sed 's/^/   /'
  print -r -- "   Open that link in Safari or Chrome on this Mac, press Register passkey, and confirm with Touch ID."
  print -r -- "   It works once, for 15 minutes. If it lapses, run this script again for a new one."
fi

step "Done"
print -r -- "   The keeper runs $SHA on http://localhost:$PORT."
print -r -- "   Still yours, from docs/process/keeper.md: section 4 (new Fly and Cloudflare tokens, imported),"
print -r -- "   5 (CW_KEEPER_URL=http://localhost:$PORT for the deploy scripts and prod), 6 (prove it) and 7 (retire the old tokens)."
