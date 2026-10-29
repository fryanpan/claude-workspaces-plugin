# A sandbox per Mac lead

Every Mac lead runs as the owner's macOS user, so a lead steered by an
outsider's text can read every board's data folder, every repo and every
credential on the disk. This runbook starts each lead's `claude` process
under a macOS Seatbelt profile that refuses it the other projects' files.

An agent applies it. It needs no `sudo`, no admin password and nothing from
Bryan: `sandbox-exec` runs as the owner, and any process may narrow what it
can do. The stronger option, a macOS user per lead, needs Bryan's admin
password and stays optional ([mac-lead-users.md](mac-lead-users.md)).

## What the profile allows

`scripts/lead-sandbox.ts` reads a config naming each lead and writes one
profile per lead. A profile allows everything, then:

- **denies reading and writing** the owner's home, the prod root
  (`~/Library/Application Support/claude-workspaces`, data folder included),
  every folder in `protect`, and every other lead's projects;
- **reopens, inside those**, the lead's own projects (worktrees included),
  and what Claude Code needs: `~/.claude`, `~/.claude.json` (read only), its install
  under `~/.local` (read only), `~/.bun` for plugin servers, and `~/Library/Keychains`
  to sign in. Without the keychain folder `claude -p` answers "Not logged
  in";
- **denies other projects' transcripts again**: `~/.claude/projects` and the
  scratch folders under `/private/tmp/claude-<uid>`, reopening only the
  lead's own project's folders and its worktrees' folders;
- **refuses writes, after every other rule, to what Claude Code runs or
  obeys** in `~/.claude`: `settings*.json`, `hooks`, `plugins`, `skills`,
  `agents`, `commands`, `rules`, `output-styles`, `CLAUDE.md`, the shell
  snapshots and session env files each Bash call sources, the `~/.claude`
  folder itself, and all of `~/.claude.json`. A lead can read them, so its
  own session loads them, but it cannot plant a hook, an MCP server or plugin
  code that runs outside the sandbox in Bryan's next session. The same goes
  for Claude Code's install, `~/.local/share/claude` and the
  `~/.local/bin/claude` symlink into its `versions/`, so a lead cannot
  replace the binary every unsandboxed session runs, and cannot update
  Claude Code from inside the wall. Measured on 2.1.312 (28 October):
  `claude -p` answered and ran a Bash call with the install read only. It
  also answered with `~/.local/state/claude` read only; that folder holds
  its locks and stays writable;
- **denies the config, the profiles and the prod root again** after every
  other rule, so no `allow` reopens prod and a lead cannot widen its next
  launch;
- **refuses the ways a lead could start a process outside the wall**:
  connecting to, or moving, a socket in the tmux folder
  (`/private/tmp/tmux-<uid>`, also written as `/tmp/tmux-<uid>`), so it cannot
  `tmux send-keys` into an unsandboxed session; `open` (LaunchServices
  starts the app it opens outside the sandbox); Apple events, so `osascript`
  cannot ask Terminal or iTerm to run a script; and the Shortcuts helper, so
  `shortcuts run` cannot run a shortcut there. The tmux rule is a
  `network-outbound` deny: a lead in a pane finds the socket in `$TMUX`, and a
  file deny on the folder alone still let it connect;
- **refuses the keychain**: every read goes to `securityd` over Mach, so the
  profile denies its two services and every item is refused at once. That
  also refuses Claude Code its own sign-in: measured 28 October, 21:20 PT,
  `claude -p "say ok"` inside a profile said "OAuth token revoked", and said
  "Ok." from the same profile with only the keychain deny removed. Earlier
  that day it signed in from `~/.claude/.credentials.json`; it no longer
  does. So the wrapper reads a long-lived token outside the wall and hands
  it to the lead (step 4). A lead whose config sets `allowKeychain` keeps
  the keychain (step 1).

Seatbelt applies the last rule that matches, so the profile runs from the
shortest path to the longest and the most specific folder decides. It
matches the resolved path, so every rule is written at both ends of a
symlink (`~/.claude` and `~/dev` point onto the data volume).

## Steps

**1. Write the config**, outside every lead's project, at
`~/.config/claude-workspaces/lead-sandbox.json`. Paths are absolute or start
`~/`. Name the data volume's copy of the home in `protect`. Add a lead's
other needs to `allowRead` (read only) or `allow` (read and write). This is
the default every lead on the owner's Mac starts from:

```json
{
  "leads": [
    {
      "name": "harborlight-lead",
      "projects": ["~/dev/harborlight"],
      "allowRead": [
        "~/.gitconfig",
        "~/.config/git",
        "~/.config/gh",
        "~/.nvm/versions/node",
        "~/Library/Caches/claude-workspaces/relay",
        "~/claude-hive-mcp",
        "~/dev/github-claude-channel",
        "~/dev/<hook-repo>/scripts/gradle/pretooluse-gradle.sh",
        "~/dev/ai-team-lead/scripts/usage_statusline.py"
      ]
    },
    { "name": "riverbend-lead", "projects": ["~/dev/riverbend"] }
  ],
  "protect": ["/Volumes/Data/Users/<owner>"]
}
```

Each line is there because a session with the owner's full settings broke
without it. All of them are read only.

| Path | What broke without it | Why reading it is safe |
|---|---|---|
| `~/.gitconfig`, `~/.config/git` | `git status` and `git commit`: `unable to access '~/.config/git/config'` | git's own settings and ignore list; no credential lives there |
| `~/.config/gh` | `gh auth status` exits 1: `failed to load config` | the lead could already act as the owner on GitHub through `gh`; reading its config grants nothing more |
| `~/.nvm/versions/node` | the claude-workspaces MCP server's node fallback (used when the compiled relay is missing) | installed node versions: code, no data |
| `~/Library/Caches/claude-workspaces/relay` | the claude-workspaces MCP server: the compiled relay is exec'd, then dies (exit 139) when it cannot read itself | read only on purpose: write would let a lead replace a binary that every unsandboxed session runs. A new plugin version cannot build its relay inside the wall, and falls back to node |
| `~/claude-hive-mcp` | the `claude-hive` MCP server failed to start | the server's code; its message store is `~/.claude-hive.db`, which stays denied and is reached through the broker as before |
| `~/dev/github-claude-channel` | the GitHub channel plugin did not load: it is installed from a `directory` marketplace, so Claude Code reads the plugin from that repo, not from the cache | the plugin's own code; the repo holds no `.env` at its root, and its token reaches the broker from the environment, not a file |
| `…/pretooluse-gradle.sh` | the owner's `PreToolUse` hook in `settings.json` exited 126 on every Bash call | one self-contained script that reads only its stdin |
| `…/usage_statusline.py` | the status line (interactive sessions only) | one script. It reads `~/.claude.json`, already open, and its write of the usage meter in `~/Library/Application Support/team-lead` is refused, so only an unsandboxed session updates the meter |

Two rules carry to a lead with other needs. A hook or status line that
lives in another repo gets that one file, never the repo. A plugin from a
`directory` marketplace (`extraKnownMarketplaces` in `settings.json`) gets
its folder, read only.

**A lead that needs `gh` or git over HTTPS** sets `"allowKeychain": true` in
its entry. Both keep their credential in the keychain on the owner's Mac
(`gh` in the keyring, git through the `osxkeychain` helper), and with the
keychain refused, measured 28 October, `gh auth status` exits 1 and
`git ls-remote` of a private repo over HTTPS exits 128. A fetch of a public
repo still works. Every other lead is refused the keychain by default,
because a lead that can read it reads every item there, the Cloudflare and
Fly tokens included until the keeper's cutover. A lead that needs only git
fetch and push to named GitHub repos lists them in `githubRepos` instead and
keeps the keychain refused ("GitHub through the proxy", below).

**A test lead for the board wall** sets `"boardWall": true` and its board's
id, `"boardId": "w-…"`, in its entry. The profile then denies every board
server's port (8787 to 8790, the list in
`packages/server/src/reserved-ports.ts`, which `bun run staging` also
enforces) at every address, and every socket in the board socket folder but
its own board's, and every write in that folder. So the lead's only way to a
board is its own board's socket, where the server holds each request to that
board whatever token it carries. In the lead's own projects the profile
also denies every new symlink and hard link outside a `node_modules`
folder, and renaming or removing a `node_modules` folder: the server reads
and writes the projects a lead binds, and a link the lead made in one, or
made elsewhere and moved in, would carry the server outside it. `bun
install` and `npm install` still work, since their links are in
`node_modules`, and the server refuses every path through one. The server
runs no git in a folder a lead bound, so the lead's git settings stay
writable: commits, `git push -u`, `git config` and `git worktree add` work.
The cost: a walled lead cannot check out a repository whose tracked files
include symlinks outside `node_modules`, and cannot rename or delete a
`node_modules` folder. The folder is the config's top-level
`boardSocketDir`, or `/private/tmp/cw-<uid>-boards` when unset; a folder too
long for a socket path is refused. A server on prod's port, 8787, opens the
sockets in the default folder unless started with `CW_BOARD_SOCKETS=0`; any
other server opens them only with `CW_BOARD_SOCKETS=1` (or
`CW_BOARD_SOCKET_DIR` / `--board-socket-dir` naming the folder).

`--lead` launches such a lead with `CW_BOARD_SOCKET` set to its own board's
socket and `CW_WORKSPACE_ID` to its board, and with no `at1.` or `at2.` value
in its environment. Its MCP child is then the node relay dialling that
socket, and the server keeps the board token the relay's tools need, so the
lead holds none, and none is written to disk. The plugin's hooks post over
the same socket. Before the lead starts, the launch sends the server the
lead's projects, resolved, as the folders it may bind onto its board
(`PUT /api/board-sockets/<board>/roots`, loopback only, refused on a
socket); if the server does not take them, the launch says so and the lead's
folder binds are refused. On its own board the lead may also list docs,
rewrite a doc, bind one of those projects (narrowed with `include`, never a
folder inside one, which it could swap for a link) and post notes, which a
board member may not (`packages/server/src/middleware/lead-scope.ts`), and it
keeps its board when the board is closed to outside visitors.

`--check` connects to each port at both loopbacks and
each LAN and tailnet address from inside the profile (each must be refused
with `EPERM`), to its own board's socket (it must not be), and to each other
board's socket in the folder (each must be refused, and must connect without
the wall: the control). The socket rows need a server with board sockets on;
with no other board's socket in the folder, that row fails. Real leads leave
it off and are unchanged.

**A lead that runs tmux sessions of its own** sets `"allowTmux": true` in its
entry. Every other lead is refused the tmux socket by default, because a lead
that can reach it can `tmux send-keys` into any unsandboxed session, the Team
Lead's included. The opt-out drops the tmux rules and its `--check` row, and
nothing else. The Team Lead itself runs outside the wall and keeps starting,
reading and sending to leads' panes as before (measured below).

**2. Dry run.** It writes nothing, and prints each profile and the command
that launches each lead.

```bash
bun scripts/lead-sandbox.ts --config ~/.config/claude-workspaces/lead-sandbox.json
```

**3. Check.** It writes the profiles, then lists each lead's own projects
(they must list: the control) and every protected folder (it must refuse)
from inside that lead's profile, then asks `bun` (from PATH, as the hooks
run it) how many environment variables it sees from the lead's first
project: zero is a failure. Any failure exits 1 and names the lead and
the folder. It never lists the prod root; the home folder above it proves
the same deny.

Then six rows per lead try the ways out of the wall and the keychain
(`scripts/lead-sandbox-escapes.ts`), each with a control outside it:

| Row | Inside the profile | Control outside |
|---|---|---|
| tmux | connecting to a tmux server of the check's own, by socket path as `$TMUX` gives it, and moving that socket into the project: both refused | the same server answers `tmux ls` |
| open | `sandbox_check` says `lsopen` is denied | none needed: it is the sandbox's own verdict |
| osascript | `sandbox_check` says `appleevent-send` is denied | as above |
| shortcuts | `shortcuts list` fails | `shortcuts list` answers |
| launchd | a `launchctl submit` of `/usr/bin/true` is not loaded (launchd's own refusal; no rule of ours) | the same job submitted outside loads, and is removed at once |
| keychain | `security find-generic-password` of a dummy item the check made (`lead-sandbox-check-harborlight`) is refused | the same read outside returns it; the item is deleted after |
| claude install | `touch` of a new file in the folder `~/.local/bin/claude` resolves into is refused | that folder is writable (asked with `access`, so nothing is made); a file the wall let through is removed |

`open` and `osascript` are asked of the sandbox rather than driven, because
driving them would start an app or show a window. The check starts and kills
its own tmux server and never touches another session. Removing any one of
the five rules fails its row; `scripts/lead-sandbox.test.ts` does that for
each, against the real `sandbox-exec`.

```bash
bun scripts/lead-sandbox.ts --config ~/.config/claude-workspaces/lead-sandbox.json --check
```

One more row, `claude turn`, runs `claude -p "say ok"` inside each lead's
profile with the token step 4 hands over, and must answer. It spends a model
turn per lead, so it runs only with `--turn`. A plain `--check` prints it as
`skip` and counts it as not run, never as held.

```bash
bun scripts/lead-sandbox.ts --config ~/.config/claude-workspaces/lead-sandbox.json --check --turn
```

**4. Launch the lead through the wrapper**, from prod's checkout, which no
lead can write. Launched from a lead's own project, the lead could edit the
generator of its next profile; the wrapper warns when it is.

```bash
bun "$HOME/Library/Application Support/claude-workspaces/repo/scripts/lead-sandbox.ts" \
  --config ~/.config/claude-workspaces/lead-sandbox.json \
  --lead harborlight-lead -- claude <the lead's usual flags>
```

It writes the profile, then runs `sandbox-exec -f <profile> claude …` in the
lead's first project with the terminal handed through.

Before that it reads the lead's Claude Code token outside the wall, from the
keychain item `claude-workspaces-secret.claude-lead-oauth-token` (account
`claude-workspaces`, stored BASE64, as a secret card stores it), and passes
it to the lead as `CLAUDE_CODE_OAUTH_TOKEN`. The value goes into the child's
environment only: never printed, logged or written, and the dry run does not
read it. To make one, run `claude setup-token` outside the wall and save what
it prints through a secret card named `claude-lead-oauth-token`. Without the
item the launch is refused, naming it, because a walled lead without it
cannot answer. A lead with `allowKeychain` and no account named can still
sign in from the keychain, so for it the token is optional.

### Which Claude account a lead signs in as

Bryan has more than one Claude account. The config labels them, and each
label has a keychain item of its own, `claude-workspaces-secret.claude-lead-oauth-token.<label>`:

```json
{
  "claudeAccounts": ["harborlight", "riverbend"],
  "defaultClaudeAccount": "harborlight",
  "leads": [
    { "name": "harborlight-lead", "projects": ["~/dev/harborlight"] },
    { "name": "riverbend-lead", "projects": ["~/dev/riverbend"], "claudeAccount": "riverbend" }
  ]
}
```

A lead signs in as the account `--claude-account` names for that launch,
else its own `claudeAccount`, else `defaultClaudeAccount`. When the config
names no account at all, every lead uses the un-labelled item above. The
labels are the config's own; the repo holds none. To make a label's item,
run `claude setup-token` signed in as that account and save the token
through a secret card named `claude-lead-oauth-token.<label>`.

**To switch a lead to the other account**, either set its `claudeAccount`
and relaunch it, or keep the config and relaunch with the flag:

```bash
bun "$HOME/Library/Application Support/claude-workspaces/repo/scripts/lead-sandbox.ts" \
  --config ~/.config/claude-workspaces/lead-sandbox.json \
  --lead riverbend-lead --claude-account harborlight -- claude <the lead's usual flags>
```

A running lead keeps the account it was launched with; the switch takes
effect at the relaunch. A label not in `claudeAccounts`, or one whose item
is missing, refuses the launch and names the item, for an `allowKeychain`
lead too. The dry run prints the account and item each lead resolves to,
never the token, and `--check --turn` runs each lead's turn as that account.

## GitHub through the proxy

A lead whose entry names repos fetches and pushes them through
`scripts/git-proxy.ts`, a small Bun process on `127.0.0.1:8793` that holds
Bryan's GitHub credential. The lead never holds that credential, and never
reads `~/.ssh` or the keychain:

```json
{ "name": "harborlight-lead", "projects": ["~/dev/harborlight"],
  "githubRepos": ["Harborlight/notes", "Harborlight/site"] }
```

**What the wrapper writes**, at `--write` and at each launch, in
`~/.config/claude-workspaces/git-proxy/<lead>/`, mode 700:

- `token`: 32 random bytes, mode 600, made once and kept across launches.
  Delete it to rotate it; the next launch makes a new one.
- `gitconfig`, which every git inside the wall reads, because the wrapper
  launches the lead with `GIT_CONFIG_COUNT=1`,
  `GIT_CONFIG_KEY_0=include.path` and `GIT_CONFIG_VALUE_0=<that file>`:

  ```ini
  [url "http://127.0.0.1:8793/"]
  	insteadOf = git@github.com:
  	insteadOf = ssh://git@github.com/
  	insteadOf = https://github.com/
  [credential "http://127.0.0.1:8793"]
  	helper =
  	helper = "!f() { test \"$1\" = get || exit 0; echo username=<lead>; printf 'password='; cat '<token file>'; echo; }; f"
  ```

  The empty `helper` drops every helper configured before it, the keychain's
  included, for the proxy's URL only. The token is read from its file when
  git asks, so it is in no environment variable.

**What the profile adds.** For a lead with repos, its own folder above is
readable and, after every other rule, not writable. Every other lead's folder
stays under the denied home. A lead with no repos gets
`(deny network-outbound (remote ip "localhost:8793"))` and cannot reach the
proxy at all. `gitProxyPort` at the top of the config changes the port for
the profiles and the proxy together.

**What the proxy answers**, in this order:

| Request | Answer |
|---|---|
| anything but one repo's `info/refs?service=…`, `git-upload-pack` or `git-receive-pack` (the dumb-HTTP paths, a dot step, an encoded character) | 404 |
| no token, or a token no lead holds | 401 |
| a repo not in that lead's `githubRepos` (GitHub's names match without case) | 403 |
| a push that deletes a ref | 403 |
| a push that moves the default branch other than forward (a force-push, a reset back) | 403 |
| everything else | sent to `https://github.com` with Bryan's credential |

A push that creates a ref is allowed, and so is a force-push to any branch
but the default one, which a rebase needs. The default branch is whatever
upstream's `HEAD` points at, read on each push from the `symref=HEAD:<ref>`
capability of its `git-upload-pack` ref advertisement (the receive-pack one
names no HEAD). If that cannot be read, every branch gets the fast-forward
rule. One refused command refuses the whole push. The proxy reads its config and every token file on each request, so a
new lead or a changed list needs no restart.

**How it tells a fast-forward on the default branch.** The client's old sha cannot tell: git sends
the ref's current value as old for a force-push too. So the proxy asks
whether old is an ancestor of new. It adds `no-thin` to the push's
capabilities, so the client sends a pack whose deltas need nothing from
GitHub, reads the pushed commits from it in a scratch repo, and walks from
new down to the commits GitHub already has. Old met on the way means yes;
otherwise it asks GitHub's compare API (`/repos/<repo>/compare/<old>...<commit>`)
for each commit where the walk left the pack, and `ahead` or `identical`
means yes. A pack it cannot read, or a compare that fails, is a refusal.

**The credential.** The proxy runs `gh auth token` once at start (or
`--credential-command <sh>`), keeps the answer in memory, and sends it only
to GitHub. It writes it nowhere, passes it to no child process, returns no
upstream header but the content type and caching ones, replaces a GitHub
refusal with fixed text, and redacts it, raw and in its Basic form, from
every other error text and every log line.

**Starting it.** Nothing installs or starts it. By hand:

```bash
bun "$HOME/Library/Application Support/claude-workspaces/repo/scripts/git-proxy.ts" \
  --config ~/.config/claude-workspaces/lead-sandbox.json
```

As a service: fill the placeholders in
`scripts/launchd/com.fryanpan.git-proxy.plist.template`, copy it to
`~/Library/LaunchAgents/com.fryanpan.git-proxy.plist`, then
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.fryanpan.git-proxy.plist`.
Run it from prod's checkout, which no lead can write. Not measured yet:
whether `gh auth token` reads the keychain from under launchd.

**What it was proved against.** `scripts/git-proxy.test.ts` drives a real
`git` client, configured with the wrapper's own files, through the proxy to
bare repos served by `git http-backend`, with a fake credential: a clone and
a fast-forward reach the upstream, including one the compare API decides; a
force-push to a feature branch succeeds; a push to an unlisted repo, a
force-push and a reset back on the default branch, and a branch delete are
each refused and the upstream ref is unchanged; with upstream's `HEAD`
moved to another branch, the rule moves with it; with HEAD unreadable, a
force-push to a feature branch is refused; no token, a wrong one and
the owner's own credential get 401. A tap between git and the proxy keeps
every byte both ways, and the fake credential is in none of them, nor in a
log line, while the upstream saw it on every request. An upstream error that
repeats the credential reaches the client redacted.
`scripts/git-proxy-lead.test.ts` runs the profile under the real
`sandbox-exec`: a lead with repos reaches the port and reads its token, and
cannot write it; a lead without them reaches neither. Not run yet: a real
push to GitHub through it.

## Restarting the fleet's leads under it

Nothing here restarts a session. Moving a lead is a session restart:

1. Add the lead to the config and run `--check` until it holds.
2. End the lead's session at a quiet point, as for any restart.
3. Start it again through the wrapper with the flags and environment it
   uses today (`CW_AGENT_NAME`, `CW_WORKSPACE_ID`, channel flags).
   `--continue` and `--resume <session id>` work, because the transcript
   folder is the lead's own.
4. From the new session, `ls` another project's folder must answer
   `Operation not permitted`, and its own project must list.

What step 3 looks like depends on what started the lead. The wrapper runs
the binary it is given, so a shell function or alias named `claude` does
not apply after `--`; and a shell started inside the wall cannot read
`~/.zshrc`. The shell therefore runs outside, expands the flags, and hands
the wrapper the binary. Below, `$WRAP` is shorthand, written out in full, for
`bun "$HOME/Library/Application Support/claude-workspaces/repo/scripts/lead-sandbox.ts" --config ~/.config/claude-workspaces/lead-sandbox.json --lead <lead>`.

- **tmux through `zsh -ic`** (every lead on the owner's Mac today: the Team
  Lead's respawn skill starts each one as `tmux new-session -d -s <slug> -c
  <project> -e … /bin/zsh -ic "claude --continue -n <Name> --remote-control
  <Name>"`). Keep the tmux line and its `-e` list, and change only the
  command zsh runs:
  `/bin/zsh -ic '$WRAP -- "$(whence -p claude)" "${CLAUDE_CHANNEL_FLAGS[@]}" --continue -n <Name> --remote-control <Name>'`.
  The change belongs in the respawn skill, in the Team Lead's repo.
- **A shell alias or function**: the same expansion, typed or put in a new
  function: `$WRAP -- "$(whence -p claude)" <the flags the alias adds> "$@"`.
- **A launchd job**: `ProgramArguments` becomes `bun`, the wrapper's path,
  its flags, `--`, and the absolute path of `claude` with the job's flags.
  launchd runs no shell, so every flag is written out. None of the owner's
  launchd jobs starts a lead today.
- **FleetView**: whatever command it runs for a lead takes the same prefix,
  `$WRAP -- <absolute claude path> <flags>`. No lead was running under it on
  16 October.

Two leads are not candidates yet. The Team Lead drives tmux and reads every
lead's folder to respawn them. The Workspaces lead's deploy fallback runs
`git pull` in prod's checkout, which the profile denies after every other
rule.

## What it was proved against

On the owner's Mac, 16 October 2026, with Claude Code 2.1.301, against
throwaway Harborlight and Riverbend folders:

- `--check` held 8 of 8 for two leads.
- `claude -p` launched through the wrapper started, signed in from the
  keychain, read and wrote its own project, and got `Operation not permitted`
  listing, reading and writing the Riverbend folder. It ran with
  `--permission-mode bypassPermissions`, so the refusals came from the
  sandbox and not from Claude Code's own permission checks.
- That run loaded no user settings, plugins, hooks or MCP servers
  (`--setting-sources project --strict-mcp-config`).

The same day, a second probe ran `claude -p` through the wrapper with the
owner's full settings: every plugin, hook and MCP server, the permission
mode they set (`auto`), and the channel flags the leads launch with. No
board id was set, so no hook posted anywhere. With the default config
above:

- the claude-workspaces MCP server connected and answered a read
  (`list_watched_docs`), as did the `claude-hive` server and the GitHub
  channel plugin;
- `git status`, `git commit` and `gh auth status` succeeded in the probe's
  repo;
- every hook ran and exited 0: three on SessionStart, the PreToolUse hooks
  on each Bash call, UserPromptSubmit and Stop;
- `--continue` resumed the probe's previous session;
- reading a Riverbend file and listing `~/dev` still answered
  `Operation not permitted`. Listing `~/dev` now answers with its names:
  see "Names, not contents, of the folder above each project" below.

Without the config's `allowRead` list, the same probe broke on each row of
the table in step 1. The status line is the exception: `claude -p` draws
none, so its script was run inside the wall by hand, on a sample input, and
printed its line. `--remote-control` and an interactive session were not run
inside the wall.

`scripts/lead-sandbox.test.ts` drives the real `sandbox-exec` when it is
present and skips, saying so, when it is not (Linux CI).

### The ways out, probed 28 October

From inside a generated profile, cwd the lead's own project, Claude Code
2.1.312:

| Way out | Before | After |
|---|---|---|
| `tmux ls`, then `send-keys` into an unsandboxed session | `tmux ls` exit 0, every session listed | exit 1: `Operation not permitted` on the socket; also with `$TMUX` set, as in a pane |
| `open` an app or a `.command` file | `sandbox_check` says `lsopen` allowed | denied. `open` itself was never run |
| `osascript` telling Terminal or iTerm to run a script | `appleevent-send` allowed | denied. `osascript -e 'return 1'` still runs, and `do shell script` runs inside the wall (it could not list another project) |
| `shortcuts run` | `shortcuts list` answered | exit 1, "Couldn't communicate with a helper application". `run` was not tried: it would run a real shortcut |
| `launchctl submit`, `bootstrap`, `load` | refused already: submit exit 1, bootstrap error 5, the job never ran | unchanged; no rule needed |
| `crontab`, `at` | refused already: the sandbox will not exec a setuid binary | unchanged |
| `launchctl asuser` | runs, but its child is still inside the wall (could not list another project) | unchanged |
| `ssh` to this Mac (Remote Login is on) | port 22 connects; the login is refused for lack of a key, inside and outside alike | not closed; see below |
| Spotlight (`mdfind` over another project) | 0 results inside, 169 outside | unchanged |

`--check` then held 20 of 20 for two leads. `claude -p` through the wrapper
with `$TMUX` set, signed in, read and wrote its own project, and its own
Bash calls got `Operation not permitted` from `tmux ls`, `shortcuts list` and
a Riverbend file. A second run with the owner's full settings connected every
MCP server (`claude mcp list`) and answered `list_watched_docs`. The hooks'
exit codes were not read in either run.

**A lead in a tmux pane, with the deny.** A tmux server of the probe's own
started the wrapper in a pane, as the respawn skill does, with `$TMUX` set.
From outside, `tmux ls`, `send-keys` and `capture-pane` on that pane all
worked: the keys ran `claude -p` in the pane, and an interactive `claude`
there took a trust prompt answered by `send-keys`, ran a Bash call that wrote
its own project, and exited on `/exit`. From inside the pane, `tmux ls`
answered `error connecting to … (Operation not permitted)`. The pane needs
no socket: its process reads and writes the pty tmux gave it.

## What the wall does not cover yet

Two gaps stay open. Each has a planned fix, and no new Mac isolation (App
Sandbox, a macOS user per lead, a VM) is planned for either.

- **The board server trusts a loopback caller.** Measured 28 October: from
  inside a profile, `curl http://127.0.0.1:8787/workspaces?format=json`
  answers 200. A caller on loopback with no token is trusted-local, so a
  lead can read every board, mint a token for any board, and ask the server,
  which runs as Bryan outside the wall, to read a file the lead cannot. The
  lead's own MCP child and hooks reach the same port, so the profile cannot
  simply deny it. This closes with a board agent token per lead, scoped to
  that lead's board: the same token a lead on Fly needs. The wall
  (`boardWall`, above), the board sockets it leaves one of open, and the
  relay that carries the lead's MCP calls over that socket have landed, prod
  serves the sockets by default, and the plugin's hooks post over the socket
  too. What is left is a real lead setting `boardWall`.
- **The keychain answers a lead with `allowKeychain`.** By default the
  profile refuses the keychain (step 1): measured 28 October, a dummy item
  read back from inside a profile before the rule was refused after it
  (exit 44). Claude Code now signs in from the token the wrapper hands it
  (step 4), not from the keychain or `~/.claude/.credentials.json`:
  measured 28 October, 21:20 PT, `claude -p` inside a profile without it
  said "OAuth token revoked". The token is in every walled lead's
  environment, so any lead can act as Bryan's Claude account. A lead
  that sets `allowKeychain` for `gh` or git over HTTPS still reads every
  item. That closes with the keeper ([keeper.md](keeper.md)), which moves the
  fleet's secrets behind Bryan's passkey.

## What this does not close

- **`ssh` to this Mac.** Remote Login is on, so port 22 on loopback answers
  inside the wall. Today the login is refused, inside and outside alike,
  because no key the lead can reach is authorized (`~/.ssh` is denied and the
  agent holds none). A profile rule cannot deny it cleanly: `localhost:22`
  misses the Mac's LAN address, and `*:22` also refuses `git` over ssh to
  GitHub. Adding a key to `authorized_keys` and to the agent would open it.
- **Not probed:** Login Items and Folder Actions (both need an app bundle or
  Apple events), the pasteboard (`pbpaste` answers inside the wall), and
  messages to other sessions over `claude-hive`, which another session acts
  on as it would on any peer's message.
- **`~/.claude` is shared.** The lead reads all of it except other
  projects' transcripts, and writes what is not code or settings.
  `history.jsonl` holds every project's prompts, `file-history` holds file
  backups from every session, and `~/.claude.json` lists every project.
  Splitting them needs a config folder per lead, which means signing each
  lead in again: on 17 October a `claude -p` with its own `CLAUDE_CONFIG_DIR`
  answered "Not logged in".
- **What a read-only `~/.claude.json` and settings cost.** Measured on 17
  October with Claude Code 2.1.302: a `claude -p` with every write under
  `~/.claude` and to `~/.claude.json` refused still signed in and ran a Bash
  call. Not measured: an interactive session. Inside the wall a lead cannot
  `claude mcp add`, install or update a plugin, accept a new project's trust
  dialog for good, or keep its shell snapshot; do those from an unsandboxed
  session.
- **Names, not contents, of other scratch folders.** Claude Code opens
  `/private/tmp/claude-<uid>` itself at start, so a lead can list the names
  of the other projects' scratch folders there.
- **Names, not contents, of the folder above each project.** bun 1.3.10
  starts with an empty environment when it cannot list the folders above
  its cwd, so every hook lost `CW_WORKSPACE_ID` and the Stop hook posted
  nothing (measured 28 October: 0 variables, 57 once the parent lists).
  `file-read-metadata` there is not enough. So the profile allows
  `file-read-data` on the parent of each own project, at both ends of a
  symlink, as a literal: `ls ~/dev` lists the sibling projects' names, and
  listing or reading inside one is still refused. A parent inside another
  lead's project gets no such rule.
- **Claude Code's own Bash sandbox cannot start inside this one.** A nested
  `sandbox-exec` fails with `sandbox_apply: Operation not permitted`. The
  owner's settings do not turn it on today.
- **Connectors are account-wide.** A login that carries claude.ai connectors
  reaches the owner's mail and documents from inside any sandbox.
- **`sandbox-exec` is deprecated** in Apple's documentation, though it ships
  and works on this macOS. If a release removes it, the macOS user per lead
  is the fallback.
