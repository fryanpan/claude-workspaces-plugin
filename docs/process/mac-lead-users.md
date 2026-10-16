# A macOS user per Mac lead

Every Mac session runs as the owner's macOS user today, so a lead steered by
an outsider's text can read every board's data folder, every repo and every
credential on the disk. This runbook gives each Mac lead and helper (an
outreach session, the relay client) a standard macOS user of its own that
cannot read the owner's folders or another lead's home.

Bryan runs it, because creating users needs his admin rights. An agent writes
and tests the script, and never runs it.

**The default is the sandbox in [lead-sandbox.md](lead-sandbox.md)**, which
an agent applies with no admin password: it starts each lead's `claude` under
a Seatbelt profile that refuses it the other projects' files. This runbook is
the optional stronger step on top of it.

## What the script does

`scripts/mac-lead-users.ts` reads a config that lists the users. For each one
it:

1. creates a standard user, never an admin, if the user does not exist. It
   asks for that user's password at the terminal;
2. creates the user's home folder if it is missing;
3. adds a deny entry to the ACL of every protected folder, so the user can
   neither list nor enter it. The protected folders are the ones the config
   names, each at its real path too (so `~/.claude`, a symlink onto the data
   volume, is protected at both ends), and every other lead's home.

It only adds. It never deletes a user, a file or an ACL entry, never demotes
an admin, and never changes a folder's mode. It reads the machine first and
plans only what is missing, so running it twice makes no second change. It
prints each change before it makes it, and stops at the first one that
fails. A user that already exists as an admin is left alone, and the run says
so.

## Steps

**1. Write the config**, outside the repo, for example at
`~/.config/claude-workspaces/mac-lead-users.json`. Names are `cw-` and
lowercase words. `protect` defaults to your home folder when left out; name
the data volume's copy of it too.

```json
{
  "users": [
    { "name": "cw-harborlight-lead", "fullName": "Harborlight lead" },
    { "name": "cw-harborlight-outreach", "fullName": "Harborlight outreach" },
    { "name": "cw-relay", "fullName": "Relay client" }
  ],
  "protect": ["/Users/<you>", "/Volumes/Data/Users/<you>"]
}
```

**2. Dry run.** It changes nothing, and it prints every user and every deny
entry it would add, each with the exact command.

```bash
bun scripts/mac-lead-users.ts --config ~/.config/claude-workspaces/mac-lead-users.json
```

**3. Apply.** `sudo` does not search your bun's folder, so pass its path.

```bash
sudo "$(which bun)" scripts/mac-lead-users.ts --config ~/.config/claude-workspaces/mac-lead-users.json --apply
```

**4. Check.** It lists each protected folder as each lead user. Each user
must still list its own home, which is the control. Every protected folder
must refuse. Any failure exits 1 and names the user and the folder.

```bash
sudo "$(which bun)" scripts/mac-lead-users.ts --config ~/.config/claude-workspaces/mac-lead-users.json --check
```

A volume mounted with "Ignore ownership on this volume" ignores ACLs too. The
check catches that, because the folders on it list.

**5. Start a lead under its user.** The user cannot reach anything in your
home, your bun and your Claude Code install included, so it needs its own:

```bash
sudo -iu cw-harborlight-lead
# install Claude Code and bun into this user's home, clone the project's repo
# here, sign Claude Code in, then start the session with the board's address:
FEEDBACK_BASE_URL=http://127.0.0.1:8787 FEEDBACK_AGENT_NAME="Harborlight lead" claude
```

**6. Prove it.** From that session, listing the board's data folder must fail
with `Permission denied`.

```bash
ls "/Users/<you>/Library/Application Support/claude-workspaces/data"
```

## What this does not close

- **The board server still trusts loopback.** A walled-off user can still
  call the board on `127.0.0.1:8787`. A caller on this machine is trusted
  local, and today's agent token names no board. The board-scoped agent token
  in the plan is what closes that. Until it ships, this wall covers files
  only.
- **The server reads files as the owner.** Binding a file or folder by path
  is a trusted-local route, and the server runs as the owner. So a
  walled-off user that reaches the board over loopback can ask the server to
  read a file it cannot read itself. The board-scoped token closes this too,
  by refusing those routes.
- **Connectors are account-wide.** A Claude Code login that carries claude.ai
  connectors reaches the owner's mail and documents whatever macOS user runs
  it.

## Undoing a step by hand

The script has no undo, by design. To take a deny entry off a folder, remove
exactly the entry it added:

```bash
sudo chmod -a "user:cw-harborlight-lead deny list,search,add_file,add_subdirectory,delete_child,readattr,readextattr,readsecurity" "/Users/<you>"
```

Removing a user deletes its home. That is your decision to make, and nothing
here makes it.
