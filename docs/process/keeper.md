# The keeper (retired)

The keeper was a separate process, run as the relay's macOS user
`cw-relay`, that held the Mac's Cloudflare and Fly tokens and ran calls for
agents behind Bryan's passkey. Workflows on main now do its jobs, with no tap
(Bryan, 19 Nov 2026). The Fly org token is in the GitHub Environment
`fly-org`, and the Cloudflare write token is in `cloudflare-prod`. No code in
this repository runs the keeper or calls it. Its code was removed in the pull
request that added this page; the page as it was before is in git history,
at commit `d0b96801e`.

## Retired

Each job, and where it runs now:

| Job | Now | Who acts |
| --- | --- | --- |
| Make a project's Fly app, volume, bucket, backup key and tunnel token | `.github/workflows/fly-provision.yml`, dispatched on main with the project (docs/process/project-machine.md, "What the deploy needs") | nobody: a dispatch |
| Push deploy keys to a project's repos | the same workflow, for the project's `pushRepos` in `machines.json`; a merged change names the repos, never a dispatch input | nobody |
| `fly logs`, `fly ssh`, restarts and board moves on the Mac | `mac-ops.ts` with the app's own token. `fly-ci-tokens.yml` cuts one every Monday: the app, `builder` and `wg`, 14 days | nobody |
| Read Cloudflare and `fly apps list` for the daily wall report | `.github/workflows/wall-read.yml`, daily: `cloudflare-prod`'s Cloudflare token and `fly-org`'s org token; the read is sealed to the Mac, and `machine:wall-report` downloads it | nobody |
| Make and rotate Access service tokens | `cloudflare.yml`'s apply makes a missing one; `bun run cf:rotate-token` dispatches `cf-rotate-token.yml` | nobody |
| Sync the Access email lists | retired: sign-in moves to Better Auth. `cf:sync-config` writes only the router and share-link configs | nobody |

**How a secret made in CI reaches the Mac.** A workflow seals it with the
Mac's public key (`infra/handoff/recipients.json`). The workflow uploads it
as the artifact `handoff-mac`, which is kept 8 days. The repository is
public, so the artifact is too, and only the Mac's private key opens it.
That key is in prod's folder,
`~/Library/Application Support/claude-workspaces/handoff/key`, mode 600.
`bun run handoff:pull` downloads each new run's artifact with your `gh`
login and stores what it holds:

- Keychain entries: a backup identity, a bucket key, a service token's pair.
- The Mac's Fly app tokens: `handoff/fly-tokens/<app>.json`.

`mac-ops.ts` pulls by itself when it needs an app token it does not have.

**What a compromise reaches now.**

- **`fly-org`:** every Fly app, plus a write deploy key on any repo the admin
  token reaches. Before, this needed your passkey. Now it needs a merge to
  main, or a compromised step in one of its jobs. You accepted this trade on
  19 Nov.
- **A Mac app token:** root on that one machine for up to 14 days. Any
  agent running as you can use it, with no tap. This is the main widening.

## Uninstall

Bryan runs these, on the Mac, because each needs the admin password. An
installed keeper keeps running until then; nothing reaches it, and the board
server no longer reads `CW_KEEPER_URL`.

1. Stop both launchd jobs and remove their plists:

   ```bash
   sudo launchctl bootout system/com.claude-workspaces.keeper
   sudo launchctl bootout system/com.claude-workspaces.keeper-port
   sudo rm /Library/LaunchDaemons/com.claude-workspaces.keeper.plist \
     /Library/LaunchDaemons/com.claude-workspaces.keeper-port.plist
   ```

2. Remove the keeper's release, binaries and store. The store holds the old
   tokens, so this is a credential delete, not a content delete:

   ```bash
   sudo rm -rf /Users/cw-relay/keeper
   rm -f ~/Library/Application\ Support/claude-workspaces/keeper-caller-token
   ```

3. Remove `CW_KEEPER_URL` from the `env` block of `~/.claude/settings.json`,
   and from prod's plist:

   ```bash
   /usr/libexec/PlistBuddy -c 'Delete :EnvironmentVariables:CW_KEEPER_URL' \
     ~/Library/LaunchAgents/com.fryanpan.claude-workspaces.plist
   ```

   `scripts/launchd/install.sh` no longer writes it, so a reinstall drops it
   too.

4. Revoke the keeper's tokens and delete the old Keychain entries:

   ```bash
   security delete-generic-password -s cloudflare-api-token
   security delete-generic-password -a claude-workspaces -s claude-workspaces-secret.cloudflare-api-token
   security delete-generic-password -a claude-workspaces -s claude-workspaces-secret.fly-org-token
   ```

   Then revoke the Fly token named `keeper` (`fly tokens list`, then
   `fly tokens revoke`), and delete the `claude-workspaces keeper` token in
   Cloudflare's dashboard (My Profile, API Tokens). A `security` line that
   says the item could not be found means that entry is already gone.

To check: `sudo launchctl print system/com.claude-workspaces.keeper` says it
could not find the service, and `ls /Users/cw-relay/keeper` fails.
