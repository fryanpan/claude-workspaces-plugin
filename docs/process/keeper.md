# The keeper: Cloudflare and Fly credentials behind your passkey

Today the Cloudflare API token and the Fly org token sit in your login
Keychain, where any agent running as you can read them. Either one can open a
project to anyone: a new Access application, a new Fly app, a secret moved onto
a machine. The keeper is a separate process, run as the relay's macOS user,
that becomes the only holder of both. Agents ask it to act and never see a
token.

- **Routine work needs nothing from you.** Starting, stopping and restarting a
  machine of an app the keeper created, and any read, run at once.
- **Risky setup waits for your passkey.** Creating a project, moving a token
  onto a machine (a secret or a shell), creating an Access application, and
  anything else the keeper does not recognise are held until you approve them
  with Touch ID on the approval page. One approval of a new project also covers
  that project's volume, secrets and image for 30 minutes. Its backup bucket,
  a shell, and anything else are a tap each.
- **Some requests are refused outright**, because their answer would hand the
  requester a credential or the org: `fly auth`, `fly tokens`, `fly orgs`,
  `fly wireguard`, `fly ssh issue`, `fly apps move`, `--access-token`,
  `--debug` and `--verbose` (their output may carry the token), and Cloudflare
  token creation. So is any `fly` command the keeper cannot read the way `fly`
  does: one starting with a flag, a short flag with its value joined on
  (`-aprod`), or an app named twice.

How it works and what it checks is in
[security.md](../architecture/security.md), under "The keeper holds the
Mac's Cloudflare and Fly credentials". The code is
`packages/server/src/keeper/`.

## Who does what

Every step below needs your admin password, so you do them and an agent never
does. That is deliberate: if an agent could install, update or enroll the
keeper, it could also replace it.

The steps assume the relay's macOS user is `cw-relay`, created by
[mac-lead-users.md](mac-lead-users.md). Create it there first if it does not
exist; this runbook creates no users.

`$K` below is `/Users/cw-relay/keeper`.

**Start every session below in a clean shell**: `/bin/zsh -f`, then use
`/usr/bin/sudo`. Agents run as you today, so they can edit your shell's
startup files, and a changed `sudo`, `git` or `PATH` there would run their
code with your password.

**The keeper's code never comes from your checkout.** Agents can write your
checkout, including its `origin/main` ref, so an install from there could be
any commit an agent chose. The keeper installs from its own clone, owned by
`cw-relay`, and you check the commit against GitHub before it is used.

## 1. Install the keeper

The keeper refuses to start from anything your user can write: its source,
the bun that runs it and the `fly` it calls must all be owned by `cw-relay` or
root. So it gets its own copy of each.

```bash
K=/Users/cw-relay/keeper
URL=https://github.com/fryanpan/claude-workspaces-plugin.git
/usr/bin/sudo -H -u cw-relay mkdir -p "$K/bin" "$K/state" "$K/releases"
/usr/bin/sudo -H -u cw-relay chmod 700 "$K/state"
/usr/bin/sudo install -o cw-relay -m 755 "$(realpath "$(which bun)")" "$K/bin/bun"
/usr/bin/sudo install -o cw-relay -m 755 "$(realpath "$(which fly)")" "$K/bin/fly"
/usr/bin/sudo -H -u cw-relay git clone --quiet --no-checkout "$URL" "$K/src"
```

Then the release step, which an update repeats. It fetches into the keeper's
clone, asks GitHub for `main` separately, and stops unless the two agree:

```bash
/usr/bin/sudo -H -u cw-relay git -C "$K/src" fetch --quiet origin main
SHA=$(/usr/bin/sudo -H -u cw-relay git -C "$K/src" rev-parse FETCH_HEAD)
LIVE=$(/usr/bin/sudo -H -u cw-relay git ls-remote "$URL" refs/heads/main | cut -f1)
if [ -n "$SHA" ] && [ "$SHA" = "$LIVE" ]; then
  REL="$K/releases/$SHA"
  /usr/bin/sudo -H -u cw-relay mkdir "$REL"
  /usr/bin/sudo -H -u cw-relay sh -c 'git -C "$1" archive "$2" | tar -x -C "$3"' _ "$K/src" "$SHA" "$REL"
  /usr/bin/sudo -H -u cw-relay ln -sfn "$REL" "$K/app"
  echo "installed $SHA"
else
  echo "STOP: fetched $SHA, GitHub says $LIVE. Nothing was installed."
fi
```

If it printed `STOP`, nothing changed; do not go on. The sha it printed should be the merge
commit you meant to ship; GitHub shows it on the merged pull request.

**Check it.** No line may start with `unsafe:`, and the last line must read
`store: ok`.

```bash
sudo -u cw-relay env CW_KEEPER_DIR="$K/state" CW_KEEPER_FLY_BIN="$K/bin/fly" \
  "$K/bin/bun" "$K/app/packages/server/src/keeper/keeper-bin.ts" check
```

## 2. Run it under launchd

Write `/Library/LaunchDaemons/com.claude-workspaces.keeper.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claude-workspaces.keeper</string>
  <key>UserName</key><string>cw-relay</string>
  <key>WorkingDirectory</key><string>/Users/cw-relay/keeper/app</string>
  <key>ProgramArguments</key><array>
    <string>/Users/cw-relay/keeper/bin/bun</string>
    <string>/Users/cw-relay/keeper/app/packages/server/src/keeper/keeper-bin.ts</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>CW_KEEPER_DIR</key><string>/Users/cw-relay/keeper/state</string>
    <key>CW_KEEPER_FLY_BIN</key><string>/Users/cw-relay/keeper/bin/fly</string>
    <key>HOME</key><string>/Users/cw-relay</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>/Users/cw-relay/keeper/keeper.log</string>
</dict></plist>
```

```bash
sudo chown root:wheel /Library/LaunchDaemons/com.claude-workspaces.keeper.plist
sudo chmod 644 /Library/LaunchDaemons/com.claude-workspaces.keeper.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.claude-workspaces.keeper.plist
lsof -nP -iTCP:8797 -sTCP:LISTEN
```

The `lsof` output must show two listeners, `127.0.0.1:8797` and
`[::1]:8797`, both with `cw-relay` as the user. `localhost` can resolve to
either address, so the keeper holds both and refuses to start if either is
taken (its log, `$K/keeper.log`, then names the address). If anything else
holds port 8797, stop here and find out what it is.

## 3. Register your passkey

```bash
sudo -u cw-relay env CW_KEEPER_DIR="$K/state" \
  "$K/bin/bun" "$K/app/packages/server/src/keeper/keeper-bin.ts" enroll
```

It prints a link that works once, for 15 minutes, and only on the keeper
running now: if the keeper restarts, make a new link. The first page to open
it spends it, so a copy that ends up in your browser history is no use to
anyone. Open it in Safari or Chrome on this Mac, press **Register passkey**,
and confirm with Touch ID. The page says `Registered.` If it says the link is
not open, make a new link and check `lsof` again first. The passkey is tied to
`localhost`, so approvals happen on this Mac, not on the iPad.

## 4. Move the credentials, as new ones

An agent may already have read the tokens in your Keychain, so do not move
them: make new ones, give the new ones to the keeper, then revoke the old.

1. **Fly.** In a terminal of your own, `fly tokens create org --name keeper`
   and copy the token it prints. Then:

   ```bash
   pbpaste | sudo -u cw-relay env CW_KEEPER_DIR="$K/state" \
     "$K/bin/bun" "$K/app/packages/server/src/keeper/keeper-bin.ts" import fly-org-token
   printf %s "<the org slug>" | sudo -u cw-relay env CW_KEEPER_DIR="$K/state" \
     "$K/bin/bun" "$K/app/packages/server/src/keeper/keeper-bin.ts" import fly-org-slug
   ```

2. **Cloudflare.** In the dashboard, create an API token with the same
   permissions as the current one, copy it, and import it the same way as
   `cloudflare-api-token`. Import the account id as `cloudflare-account-id`.
3. Clear the clipboard: `pbcopy < /dev/null`.
4. **Let routine calls reach the apps made before the keeper**, one line per
   existing project app:

   ```bash
   sudo -u cw-relay env CW_KEEPER_DIR="$K/state" \
     "$K/bin/bun" "$K/app/packages/server/src/keeper/keeper-bin.ts" adopt cw-<project>
   ```

## 5. Point the callers at it

- **Agents' deploy scripts**: set `CW_KEEPER_URL=http://localhost:8797` in the
  environment the fleet's sessions launch with. `machine:deploy`, `machine:drill`
  and `machine:restore` then ask the keeper for every `fly` call, and print the
  approval link when one is held.
- **The board server's sharing**: add `CW_KEEPER_URL` with the same value to
  prod's launchd environment, then restart prod. Creating a share then waits
  up to 100 seconds for your tap on the link the server log prints.

## 6. Prove it

Run these as yourself, the user every agent runs as today.

```bash
# Must fail with Permission denied: your user cannot open the keeper's store.
cat /Users/cw-relay/keeper/state/credentials.json
# The control: the keeper's own user can.
sudo -u cw-relay test -r /Users/cw-relay/keeper/state/credentials.json && echo "the keeper can read it"
# A routine call needs no passkey:
curl -s -H 'x-cw-keeper: 1' -H 'content-type: application/json' \
  -d '{"args":["apps","list"]}' http://localhost:8797/v1/fly
# A held call answers 202 with an approval link and runs nothing:
curl -s -H 'x-cw-keeper: 1' -H 'content-type: application/json' \
  -d '{"args":["apps","create","cw-keeper-probe"]}' http://localhost:8797/v1/fly
```

Open the link the last command printed, press **Deny**, and confirm with
Touch ID: denying takes your passkey too, so no other process can cancel a
request you are about to approve. Open
`http://localhost:8797` to see everything waiting for you.

## 7. Retire the old tokens

Once a routine call works through the keeper:

```bash
security delete-generic-password -s cloudflare-api-token
security delete-generic-password -a claude-workspaces -s claude-workspaces-secret.fly-org-token
```

Then revoke the old Fly token (`fly tokens list`, then `fly tokens revoke`
with the new token) and the old Cloudflare token in the dashboard.

## Updating the keeper needs your admin password

The keeper runs only from files `cw-relay` or root owns, and it checks that at
every start, so nothing your user can write changes what it runs. An update is
the release step from section 1 again, in a clean shell (`/bin/zsh -f`), from
the keeper's own clone and checked against GitHub. Then check it and restart:

```bash
/usr/bin/sudo -H -u cw-relay env CW_KEEPER_DIR="$K/state" CW_KEEPER_FLY_BIN="$K/bin/fly" \
  "$K/bin/bun" "$K/app/packages/server/src/keeper/keeper-bin.ts" check
/usr/bin/sudo launchctl kickstart -k system/com.claude-workspaces.keeper
```

Updating `bun` or `fly` is the `sudo install` line for that binary, then the
same check and restart. The older release folders are the rollback: point
`app` back at one and restart.

## What this does not close

- **Your admin password opens everything.** Anyone who has it, or a `sudo`
  session you left open in a terminal an agent can type into, can read the
  store. A takeover of the Mac still holds both tokens.
- **Three credentials stay outside the keeper**: each project's Tigris bucket
  admin key and its backup identity (in your Keychain, read by the deploy and
  restore scripts), and Home's feed tokens (`CW_HOME_REMOTES_FILE`).
- **The `bun` and `fly` it installs are copies of yours.** An agent that had
  already replaced those binaries in your user's paths would be installed
  with them. Install each from its vendor's release, as an admin, if you
  doubt them.
- **While no keeper runs, another process can take its port** and serve a
  lookalike page at the same address. It cannot get anything signed: every
  challenge and every live enrollment link belongs to a running keeper. But
  the page could still mislead you, so check `lsof` (section 2) whenever the
  keeper has restarted and a page looks wrong.
- **A held request is lost on a keeper restart.** The requester asks again.
- **Approvals are on this Mac only.** The passkey is registered for
  `localhost`; approving from the iPad needs the page on an HTTPS address of
  its own, which is not built.
