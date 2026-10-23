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
  the rest of that project's setup for 30 minutes.
- **Some requests are refused outright**, because their answer would hand the
  requester a credential or the org: `fly auth`, `fly tokens`, `fly orgs`,
  `fly ssh issue`, `fly apps move`, `--access-token`, and Cloudflare token
  creation.

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

`$REPO` below is your checkout. `$K` is `/Users/cw-relay/keeper`.

## 1. Install the keeper

The keeper refuses to start from anything your user can write: its source,
the bun that runs it and the `fly` it calls must all be owned by `cw-relay` or
root. So it gets its own copy of each.

```bash
K=/Users/cw-relay/keeper
sudo -u cw-relay mkdir -p "$K/bin" "$K/state" "$K/releases"
sudo -u cw-relay chmod 700 "$K/state"
sudo install -o cw-relay -m 755 "$(realpath "$(which bun)")" "$K/bin/bun"
sudo install -o cw-relay -m 755 "$(realpath "$(which fly)")" "$K/bin/fly"
REL="$K/releases/$(git -C "$REPO" rev-parse --short origin/main)"
sudo -u cw-relay mkdir "$REL"
git -C "$REPO" archive origin/main | sudo -u cw-relay tar -x -C "$REL"
sudo -u cw-relay ln -sfn "$REL" "$K/app"
```

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

The `lsof` line must name `cw-relay` as the listener's user. If anything else
holds port 8797, stop here: a process holding the port could show you a false
approval page.

## 3. Register your passkey

```bash
sudo -u cw-relay env CW_KEEPER_DIR="$K/state" \
  "$K/bin/bun" "$K/app/packages/server/src/keeper/keeper-bin.ts" enroll
```

It prints a link that works once, for 15 minutes. Open it in Safari or Chrome
on this Mac, press **Register passkey**, and confirm with Touch ID. The page
says `Registered.` The passkey is tied to `localhost`, so approvals happen on
this Mac, not on the iPad.

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

Open the link the last command printed and press **Deny**. Open
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
the install step again into a new release folder, then a restart:

```bash
REL="$K/releases/$(git -C "$REPO" rev-parse --short origin/main)"
sudo -u cw-relay mkdir "$REL"
git -C "$REPO" archive origin/main | sudo -u cw-relay tar -x -C "$REL"
sudo -u cw-relay ln -sfn "$REL" "$K/app"
sudo -u cw-relay env CW_KEEPER_DIR="$K/state" CW_KEEPER_FLY_BIN="$K/bin/fly" \
  "$K/bin/bun" "$K/app/packages/server/src/keeper/keeper-bin.ts" check
sudo launchctl kickstart -k system/com.claude-workspaces.keeper
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
- **A held request is lost on a keeper restart.** The requester asks again.
- **Approvals are on this Mac only.** The passkey is registered for
  `localhost`; approving from the iPad needs the page on an HTTPS address of
  its own, which is not built.
