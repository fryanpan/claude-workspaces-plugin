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
  and what Claude Code needs: `~/.claude` and `~/.claude.json`, its install
  under `~/.local`, `~/.bun` for plugin servers, and `~/Library/Keychains`
  to sign in. Without the keychain folder `claude -p` answers "Not logged
  in";
- **denies other projects' transcripts again**: `~/.claude/projects` and the
  scratch folders under `/private/tmp/claude-<uid>`, reopening only the
  lead's own project's folders and its worktrees' folders;
- **denies the config, the profiles and the prod root again** after every
  other rule, so no `allow` reopens prod and a lead cannot widen its next
  launch.

Seatbelt applies the last rule that matches, so the profile runs from the
shortest path to the longest and the most specific folder decides. It
matches the resolved path, so every rule is written at both ends of a
symlink (`~/.claude` and `~/dev` point onto the data volume).

## Steps

**1. Write the config**, outside every lead's project, at
`~/.config/claude-workspaces/lead-sandbox.json`. Paths are absolute or start
`~/`. Name the data volume's copy of the home in `protect`. Add a lead's
other needs to `allowRead` (read only) or `allow` (read and write): git and
`gh` need their config, and an MCP server installed inside some repo needs
that folder.

```json
{
  "leads": [
    {
      "name": "harborlight-lead",
      "projects": ["~/dev/harborlight"],
      "allowRead": ["~/.gitconfig", "~/.config/gh"]
    },
    { "name": "riverbend-lead", "projects": ["~/dev/riverbend"] }
  ],
  "protect": ["/Volumes/Data/Users/<owner>"]
}
```

**2. Dry run.** It writes nothing, and prints each profile and the command
that launches each lead.

```bash
bun scripts/lead-sandbox.ts --config ~/.config/claude-workspaces/lead-sandbox.json
```

**3. Check.** It writes the profiles, then lists each lead's own projects
(they must list: the control) and every protected folder (it must refuse)
from inside that lead's profile. Any failure exits 1 and names the lead and
the folder. It never lists the prod root; the home folder above it proves
the same deny.

```bash
bun scripts/lead-sandbox.ts --config ~/.config/claude-workspaces/lead-sandbox.json --check
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

## Restarting the fleet's leads under it

Nothing here restarts a session. Moving a lead is a session restart:

1. Add the lead to the config and run `--check` until it holds.
2. End the lead's session at a quiet point, as for any restart.
3. Start it again through the wrapper with the flags and environment it
   uses today (`FEEDBACK_BASE_URL`, `FEEDBACK_AGENT_NAME`, channel flags).
   `--resume <session id>` works, because the transcript folder is the
   lead's own.
4. From the new session, `ls` another project's folder must answer
   `Operation not permitted`, and its own project must list.

A lead whose launch is a launchd job or a shell alias needs that launcher
changed to call the wrapper. That edit is separate work.

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
  (`--setting-sources project --strict-mcp-config`). An interactive session
  with the plugin, hooks, git and `gh` was not run inside the wall.

`scripts/lead-sandbox.test.ts` drives the real `sandbox-exec` when it is
present and skips, saying so, when it is not (Linux CI).

## What this does not close

- **The board server still trusts loopback.** A sandboxed lead can still
  call the board on `127.0.0.1:8787`, where a local caller is trusted, and
  ask the server, which runs as the owner, to bind and read a file it cannot
  read itself. The board-scoped agent token closes that. Until it ships,
  this wall covers files only.
- **`~/.claude` is shared.** The lead reads and writes all of it except
  other projects' transcripts. `history.jsonl` holds every project's
  prompts, `file-history` holds file backups from every session, and
  `~/.claude.json` lists every project. Splitting them needs a config folder
  per lead, which means signing each lead in again.
- **Names, not contents, of other scratch folders.** Claude Code opens
  `/private/tmp/claude-<uid>` itself at start, so a lead can list the names
  of the other projects' scratch folders there.
- **Claude Code's own Bash sandbox cannot start inside this one.** A nested
  `sandbox-exec` fails with `sandbox_apply: Operation not permitted`. The
  owner's settings do not turn it on today.
- **Connectors are account-wide.** A login that carries claude.ai connectors
  reaches the owner's mail and documents from inside any sandbox.
- **`sandbox-exec` is deprecated** in Apple's documentation, though it ships
  and works on this macOS. If a release removes it, the macOS user per lead
  is the fallback.
