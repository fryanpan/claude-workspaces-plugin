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
  the other commands the project scripts send are held until you approve them
  with Touch ID on the approval page. One approval of a new project also covers
  that project's volume and secrets for 30 minutes. Its image (`fly deploy`),
  its backup bucket, a shell, and anything else are a tap each, and a deploy's
  page lists the folder it uploads, what is in it, and its `fly.toml`.
- **No `fly` call may read the keeper's own folders.** A build folder,
  `--config` or `--dockerfile` inside the keeper's home or store, through a
  link or not, is refused even with a tap, and so is a relative one. A
  `fly.toml` may hold only keys that name no local file (the app, region,
  `[env]`, `[mounts]`, `[[restart]]` and `[[vm]]`), and a `fly` command or flag
  the project scripts do not use is refused, so no flag that reads some other
  local file (`--file-local`, `--env-file`, `--build-secret`) reaches `fly`.
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

Two LaunchDaemons run the keeper. The **port job** has launchd itself listen
on the keeper's port on `127.0.0.1` and `[::1]` from boot, so no other
process can take the keeper's address, even while the keeper restarts. It
hands each connection to `/usr/bin/nc`, which passes it to the keeper's unix
socket in `$K/run`. The **keeper job** runs the keeper on that socket.

The port is drawn at random from 20000 to 60999 the first time the keeper
needs it, and kept in its store. Nothing on this Mac may learn it before the
port job holds it, and an agent running as you can read what your shell
prints and keeps. So one root step draws it, writes both plists readable only by
root, and loads the port job, and nothing prints the port until then:

```bash
/usr/bin/sudo -H -u cw-relay mkdir -m 700 "$K/run"
/usr/bin/sudo /bin/sh -c '
  set -e; umask 077; K="$1"; D=/Library/LaunchDaemons
  keeper() { /usr/bin/sudo -H -u cw-relay env CW_KEEPER_DIR="$K/state" CW_KEEPER_FLY_BIN="$K/bin/fly" \
    "$K/bin/bun" "$K/app/packages/server/src/keeper/keeper-bin.ts" "$@"; }
  keeper plist port > "$D/com.claude-workspaces.keeper-port.plist"
  keeper plist keeper > "$D/com.claude-workspaces.keeper.plist"
  chown root:wheel "$D"/com.claude-workspaces.keeper-port.plist "$D"/com.claude-workspaces.keeper.plist
  launchctl bootstrap system "$D/com.claude-workspaces.keeper-port.plist"
' sh "$K"
```

If it stops with an error, nothing was loaded unless the error came from
`bootstrap`; if `bootstrap` says the address is in use, something took the
port in the second since it was drawn: stop and find out what it is. Now the
port is held, read it, and check both plists before loading the keeper job:

```bash
PORT=$(/usr/bin/sudo -H -u cw-relay env CW_KEEPER_DIR="$K/state" CW_KEEPER_FLY_BIN="$K/bin/fly" \
  "$K/bin/bun" "$K/app/packages/server/src/keeper/keeper-bin.ts" port)
echo "$PORT"
/usr/bin/sudo cat /Library/LaunchDaemons/com.claude-workspaces.keeper-port.plist \
  /Library/LaunchDaemons/com.claude-workspaces.keeper.plist | less
```

`echo` prints a number from 20000 to 60999; in a new shell, run the `PORT=`
line again. The port plist must list `/usr/bin/nc`, `-U`,
`$K/run/keeper.sock`, and two `Sockets` entries, `127.0.0.1` and `::1`, on
that port. The keeper plist must run `$K/bin/bun` on
`$K/app/.../keeper-bin.ts` with `CW_KEEPER_SOCKET` set to the same socket and
`CW_KEEPER_PORT` set to the port. Then load the keeper job and check:

```bash
/usr/bin/sudo launchctl bootstrap system /Library/LaunchDaemons/com.claude-workspaces.keeper.plist
/usr/bin/sudo lsof -nP -iTCP:"$PORT" -sTCP:LISTEN
curl -s "http://localhost:$PORT/" | grep -c 'Waiting for your passkey'
```

The `lsof` output must show two listeners, `127.0.0.1:$PORT` and
`[::1]:$PORT`, both owned by `launchd` (process 1), and `curl` must print 1.

**Never boot out the port job** once it is loaded, except to uninstall. While
it is loaded nobody else can serve the keeper's address; the moment it is
not, anyone can. An update restarts only the keeper job.

**Then clear the keeper's site data in every browser on this Mac**, before
you open any keeper page. Until the port job was loaded, any process could
serve `http://localhost:$PORT` and leave a service worker or a cached page
there, which would show you one request while your tap approves another. In
Chrome: Settings, Privacy and security, Site data, search `localhost`, and
delete it. In Safari: Settings, Privacy, Manage Website Data, `localhost`,
Remove. Do this again if the port job is ever unloaded.

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
not open, make a new link and check `lsof` again first. If the page says
**Approvals are stopped**, follow "If approvals are stopped" below. The passkey is tied to
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

- **Agents' deploy scripts**: set `CW_KEEPER_URL=http://localhost:$PORT` (the
  number, written out) in the environment the fleet's sessions launch with. `machine:deploy`, `machine:drill`
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
  -d '{"args":["apps","list"]}' "http://localhost:$PORT/v1/fly"
# A held call answers 202 with an approval link and runs nothing:
curl -s -H 'x-cw-keeper: 1' -H 'content-type: application/json' \
  -d '{"args":["apps","create","cw-keeper-probe"]}' "http://localhost:$PORT/v1/fly"
```

Open the link the last command printed, press **Deny**, and confirm with
Touch ID: denying takes your passkey too, so no other process can cancel a
request you are about to approve. Open
`http://localhost:$PORT` to see everything waiting for you.

## If approvals are stopped

The keeper stops giving challenges and opening enrollment when a browser
shows it signs of a service worker on its address: a request for a worker
script, or a page fetched by a script rather than opened by you. Every page
then says **Approvals are stopped** and names what it saw. Any local process
can also cause this, by sending the same headers.

1. Clear the keeper's site data in every browser on this Mac, as at the end
   of section 2.
2. In a clean shell (`/bin/zsh -f`):

   ```bash
   /usr/bin/sudo -H -u cw-relay env CW_KEEPER_DIR="$K/state" CW_KEEPER_FLY_BIN="$K/bin/fly" \
     "$K/bin/bun" "$K/app/packages/server/src/keeper/keeper-bin.ts" clear-alarm
   ```

3. Open the approval link again.

If it happens again without a reason you know, check `lsof` (section 2) and
look at which processes on this Mac opened `localhost:$PORT` in a browser.

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

That restarts the keeper job only. The port job keeps the address while the
keeper is down; a page opened in that second gets no answer, never someone
else's. If an update changes the port plist (`plist port` prints something
different from the installed one), reload the port job and then clear site
data again, as in section 2.

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
- **Before the port job is loaded, anyone can serve the keeper's address.**
  A service worker left there then could show you one request while your
  tap approves another. Clearing site data after loading the port job
  (section 2) removes it. Skip that step and a worker that never contacts
  the keeper stays until you clear it. A worker that does contact the keeper
  is removed and stops approvals (above).
- **A held request is lost on a keeper restart.** The requester asks again.
- **Approvals are on this Mac only.** The passkey is registered for
  `localhost`; approving from the iPad needs the page on an HTTPS address of
  its own, which is not built.
