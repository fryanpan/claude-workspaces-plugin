# The keeper: Cloudflare and Fly credentials behind your passkey

The keeper is a separate process that holds the Cloudflare and Fly tokens.
It runs as the relay's macOS user, `cw-relay`, so agents running as you can't
read the tokens. Agents ask it to act instead:

- **Routine calls run at once:** reads, and starting or stopping a machine of
  an app the keeper made.
- **Risky calls wait for your passkey:** a new project, an Access app, a
  secret, a deploy.
- **Calls whose answer would hand over a credential are refused.**

What it allows and refuses is in [security.md](../architecture/security.md),
under "The keeper holds the Mac's Cloudflare and Fly credentials". The code is
in `packages/server/src/keeper/`.

You run every step on this page, because each one needs your admin password.
Sections 1 to 4 are one command.
If an agent could install or update the keeper, it could replace it.
`cw-relay` must already exist ([mac-lead-users.md](mac-lead-users.md)).

## 1. Install, or update

Run this in Terminal, with `<sha>` replaced by the merge commit you mean to ship:

```bash
/bin/zsh -f -c "$(/usr/bin/curl -fsSL https://raw.githubusercontent.com/fryanpan/claude-workspaces-plugin/<sha>/scripts/keeper-install.sh)"
```

- **It installs from GitHub, not from your checkout**, because agents can
  write your checkout. `-f` skips your shell's startup files, which agents
  can also write.
- **It is safe to run again from the top** after a crash or a fix. It skips
  each step that is already done, and asks you to confirm the commit before
  installing it.
- **It stops at the first step that fails** and says which step. Fix the
  problem and run it again.

When it finishes, the keeper is running under launchd on
`http://localhost:<port>`, holds new tokens, and prod uses it: the script's
last step does sections 2 to 4.

**The first time:**

1. Clear `localhost`'s site data in every browser on this Mac. In Chrome:
   Settings, Privacy and security, Site data. In Safari: Settings, Privacy,
   Manage Website Data.
2. Open the passkey link the script printed and confirm with Touch ID. The
   link works once, for 15 minutes; run the script again for a new one.

The passkey is tied to `localhost`, so you approve on this Mac, not on the iPad.

**Never boot out the port job** (`com.claude-workspaces.keeper-port`) except to
uninstall. While it is loaded, no other process can serve the keeper's address.
If it ever is unloaded, clear `localhost`'s site data again.

## 2. to 4. Tokens, callers and the check: the same command

The install command's last step, `10. Tokens, callers and the check`, runs
`packages/server/src/keeper/keeper-setup-bin.ts` from the release it just
installed, as you. It reuses the install's `sudo`, so the whole run asks for
your admin password once. A second run skips each step already done, and
always runs the check again.

To see what it would do without changing anything, or reading a token:

```bash
cd /Users/cw-relay/keeper/app && /Users/cw-relay/keeper/bin/bun packages/server/src/keeper/keeper-setup-bin.ts --dry-run
```

It refuses to run from anywhere but the keeper's release, because it
handles the new tokens and agents can write a checkout. What a passing run
prints, step by step:

```
== Confirm the org and the account
   Fly org:            <slug>
   Cloudflare account: <account name>
   Make and store tokens for these? [y/N] y
== 1. A new Fly org token, made with your own fly login
   ok: the keeper stored fly-org-token
   ok: the keeper stored fly-org-slug
== 2. A new Cloudflare token, and the one account it sees
   ok: made a new Cloudflare token with the current one
   ok: the keeper stored cloudflare-api-token
   ok: the keeper stored cloudflare-account-id
== 3. Adopt the project apps made before the keeper
   ok: adopted cw-<project>
== 4. Point the callers at http://localhost:<port>
   ok: set CW_KEEPER_URL in ~/.claude/settings.json; sessions launched from now on have it
   ok: set CW_KEEPER_URL in ~/Library/LaunchAgents/com.fryanpan.claude-workspaces.plist
   ok: restarted com.fryanpan.claude-workspaces; it runs with CW_KEEPER_URL
== 5. Check it
   ok: /Users/cw-relay/keeper/state/credentials.json: Permission denied
   ok: the probe waits for your passkey at http://localhost:<port>/approve/<id>
   ok: withdrew the probe, so it created nothing and no tap can run it
```

- **Confirm first:** the org slug and the Cloudflare account come from
  stores anything running as you can write, so the command shows them and
  makes nothing until you answer `y`. A dry run shows them without asking.
  If you make the Cloudflare token by hand, you confirm its account after
  you paste it.
- **Fly:** it runs `fly tokens create org --name keeper` with your own `fly`
  login and the org slug from the Keychain, and hands the token to the
  keeper on stdin. The token is never printed, copied or written to a file.
  If a token is made but not stored, the STOP line says how to revoke it.
- **Cloudflare:** it asks the current token to make the new one. If the
  current token cannot make tokens, it prints the permissions to give a
  token you make in the dashboard, and waits for you to paste it (it is not
  shown). That is the only step you might do by hand. If it takes you
  longer than sudo's timeout (5 minutes by default), you may be asked for
  your password once more. The permissions:
  - on the account: Access: Apps and Policies Edit, Access: Apps and
    Policies Read, Access: Organizations, Identity Providers, and Groups
    Read, Access: Service Tokens Read, Cloudflare Tunnel Edit, Workers
    Scripts Edit;
  - on all zones of the account: Zone Read, DNS Edit, SSL and Certificates
    Read, Workers Routes Edit;
  - no API Tokens permission.

  The account id is the one account the new token sees. It goes to the
  keeper and nowhere else.
- **Project apps:** every Fly app named `cw-<project>`, the deploy's name
  for a project, is adopted, so starting and stopping it needs no passkey.
- **Callers:** `CW_KEEPER_URL` goes into the `env` of
  `~/.claude/settings.json`, which every Claude Code session launches with,
  and into prod's launchd job. Prod is restarted (bootout, then bootstrap)
  so it reads the new environment. Whether prod needs it is judged from the
  job launchd is running, not from the file, so a run cut short after the
  plist was written restarts prod the next time. The plist's old copy is kept beside it
  as `.bak.keeper-<time>`. Sessions already running keep the old
  environment until they restart. A later `scripts/launchd/install.sh`
  keeps the plist's `CW_KEEPER_URL` unless you set the variable yourself
  (`CW_KEEPER_URL=` clears it).
- **The check:** the probe asks the keeper for `fly apps create
  cw-keeper-probe`, prints the approval link, and withdraws the request, so
  nothing is created and no tap can run it later.

One caller is not covered. `bun run cf:plan` and `cf:apply`
(`infra/cloudflare/`) read the Keychain's `cloudflare-api-token` themselves,
because the Terraform provider cannot send the keeper's request header; once
section 5 deletes that entry they stop, saying no token is set, until a token
for them is stored there again. Applying is CI's job
(`.github/workflows/cloudflare.yml`), so the Mac needs that token only for a
local plan. `machine:deploy` makes no Cloudflare call: it reads the tunnel
token and the Access settings from `terraform output`.

## 5. Retire the old tokens

```bash
security delete-generic-password -s cloudflare-api-token
security delete-generic-password -a claude-workspaces -s claude-workspaces-secret.cloudflare-api-token
security delete-generic-password -a claude-workspaces -s claude-workspaces-secret.fly-org-token
```

Then revoke the old Fly token (`fly tokens list`, then `fly tokens revoke`)
and the old Cloudflare token in the dashboard.

## If a page says "Approvals are stopped"

A browser showed the keeper signs of a service worker on its address.

1. Clear `localhost`'s site data, as in step 1.
2. Run this in a `/bin/zsh -f` shell:
   `/usr/bin/sudo -H -u cw-relay env CW_KEEPER_DIR=/Users/cw-relay/keeper/state /Users/cw-relay/keeper/bin/bun /Users/cw-relay/keeper/app/packages/server/src/keeper/keeper-bin.ts clear-alarm`.
3. Open the approval link again.

## What it does not protect against

- **Your admin password.** Anyone who has it, or who reaches an open `sudo`
  session, can read the tokens.
- **Four credentials it doesn't hold:** each project's Tigris admin key and
  backup identity, Home's feed tokens, and the Keychain Cloudflare token
  `cf:apply` reads, if you keep one.
- **Its `bun` and `fly`:** they are copies of yours, so an agent that had
  already replaced those binaries would have them copied in.
