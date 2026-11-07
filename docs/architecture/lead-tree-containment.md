# Lead-tree containment

**Goal:** a walled lead can bind, list and rewrite docs in its own folders from
inside its wall, and nothing the server does on those folders can be turned
into an action outside them.

A walled lead runs under a Seatbelt profile (`scripts/lead-sandbox.ts`). The
server runs as the owner, outside that profile, and reads, writes, stats,
lists and runs git on files under the lead's registered roots
(`board-socket-roots.ts`). Every one of those calls acts with the owner's
rights on a tree the lead controls. Each is an escape route if it follows
something the lead planted:

- a symbolic link, anywhere on the path, swapped in before or during the call;
- a folder renamed out of the root while it holds a link;
- a hard link to an owner file, made inside the root;
- a temp file name planted as a link before the server creates it;
- a git setting that names a program: `core.fsmonitor`, `filter.<d>.clean`,
  `filter.<d>.process`, `diff.<d>.textconv`, `gpg.program`, `core.hooksPath`,
  or a file that `include.path` or `includeIf` pulls in.

Five security review rounds each found a new HIGH in one of those routes,
because each fix closed the call sites the reviewer named. This doc lists
every call site, found by grep, so that the next fix is a rule that holds
everywhere.

**What "lead tree" means here:** a board's registered roots, plus the shadows
`leadShadowZone` names (the lead's scratch and transcript folders, and the
parts of `~/.claude` the wall leaves it writable). A walled lead can also write
other places its `(allow default)` profile does not deny: `/private/tmp`
outside `claude-<uid>`, `$TMPDIR`, `/Users/Shared`, other volumes, and
`/opt/homebrew`. The server is safe there only because a lead's own binds are
refused outside its roots (`leadWritable`, `refuseLeadBind`). A doc the owner or
another agent binds under one of those places is read by plain path. That is
not in this work. Neither is the `/opt/homebrew` write (review round 1, H2),
which is a wall fix another builder holds.

## The rule

1. **File reads, writes, stats, folder makes and listings on a lead tree go
   through `tree-fs.ts`, and nowhere else.** Every open names the whole path
   with `O_NOFOLLOW_ANY`. After the open, the descriptor is judged: the root's
   pinned device and inode, the same device, a regular file with one name, and
   a real path (`/dev/fd/<n>`) under the root. After the open, there is no path
   I/O: reads, writes, `fchmod` and renames use the descriptor or a folder's
   descriptor (`renameatx_np(RENAME_NOFOLLOW_ANY)`). This exists today and
   handles bound docs and folder listings (PR 1440). The work is to send the
   call sites below that still do their own path I/O through it.
2. **Git on a lead tree runs under `sandbox-exec` with a deny-default profile
   the server writes itself.** That profile lets git read the root, its own
   install and the system libraries; write `/dev/null`; and exec the git
   binary only. Git runs only asynchronously, with a timeout, SIGKILL, an
   output cap and a fixed environment that carries none of the server's
   variables. Every config hook the server can name is turned off as a second
   line. Today git is not run there at all (`gitBarred`). A synchronous caller
   keeps that answer, "cannot tell".
3. **A path is judged under a root by `PathGuards.covers`**, which respells the
   path one name at a time from `/` (links above a root are followed, none
   below). A module decides "lead tree or not" only by asking it.
4. **A path under a root never gets a repository identity.** A doc there is
   keyed by its path, never by the repository's origin. The lead writes that
   origin, and a key is looked up across every board.
5. **The exported path helpers refuse a path under a root themselves.**
   `readChecked` and its siblings, `readLine`, `statStampSync`,
   `findWorktreeRoot` and `gitCommonDir` fail closed there rather than trusting
   their caller.
6. **A new caller cannot skip the rule.** A gate, `check:tree-fs`, fails CI
   when a module in `packages/server/src` or `packages/core/src` is missing
   from its table. A module goes in the table if it imports `node:fs`,
   `node:fs/promises` or `node:child_process` in any spelling (static,
   dynamic or `require`, with or without the `node:` prefix), calls `Bun.file`,
   `Bun.write` or `Bun.spawn`, or imports one of the helpers in rule 5 or
   `@claude-workspaces/core/safe-file`.

Off macOS no walled lead exists. `treeFsMode()` is `legacy` there, and the
plain-path checks in `bound-path-checked.ts` apply. On macOS without the
native calls, every path under a root is refused. Git stays barred wherever
the sandbox is not available. All three are unchanged.

## Every server call site that can touch a lead tree

The search: every file under `packages/server/src` (tests excluded) that
imports `node:fs`, `node:fs/promises` or `node:child_process`, or calls
`Bun.file`, `Bun.write` or `Bun.spawn`: 179 modules. For each one, I traced
where its paths come from. A module whose paths are all under the data dir, the
client or widget build, the prod checkout, the plugin cache, the owner's own
config, `/proc`, or a keeper or relay store is out of scope, because no lead
can write there. Every module that can be handed a path under a root is listed
below, grouped by what it does, with a few out-of-scope ones named where a
reader would expect them. The per-module list will be the `check:tree-fs`
table described below.

"Today" is origin/main at 3413ccb27. "After" is what this work changes.
"Contained" means the call goes through `tree-fs.ts`, or is refused before
any I/O because `covers` is true.

### A. Bound docs

| Call site | What it does | Today | After |
|---|---|---|---|
| `slow-fs.ts` `read`, `write`, `statMtime` (207, 292, 319) | the pool's read, write-back and poll stat | `PathGuards` → `tree-fs` | unchanged |
| `slow-fs.ts` `takeFresh` (255) | a prewarm's bytes | dropped when covered | unchanged |
| `file-binding.ts` seed read (826) | the doc's first read at boot | `guards.readSync` → `tree-fs` | unchanged |
| `file-binding.ts` `existsSync(abs)` / `existsSync(binding.path)` (825, 1094, 1291, 1553, 1934, 2021, 2294, 2317, 2913) | "is the file there" | plain `existsSync`, follows a link | `guards.exists` → new `existsTree` |
| `file-binding.ts` `exportAndRebind` (1359–1364) | moving a doc into a project | `guards.mkdirSync` + `guards.writeSync`; the `existsSync` before it follows a link | `existsTree`; the write is unchanged |
| `file-binding.ts` `retargetHomeBinding` (1406–1412) | first write of a pinned doc | guarded write; `existsSync` follows a link | `existsTree` |
| `doc-store.ts` (1988) | a reparse read | `boundFiles.read` → `tree-fs` | unchanged |
| `file-stamp.ts` `statStampSync` (46) | the size and mtime at attach | plain `statSync` (PR 1440 follow-up 6) | `guards.statSync` |
| `routes/workspace-content.ts` import stamp (239–245) | writes the import's stamp to the task file | `guards.writeSync` when covered | unchanged |
| `doc-store.ts` boot rebind `existsSync(src)` (1669) | is the file there | follows a link | `guards.exists` |
| `doc-store-workspaces.ts` `existsSync(root)` (260) | is the set's root there | follows a link | `guards.exists` |
| `routes/workspace-content.ts` huddle seed (367–369) | creates a meeting file | the meetings home is never a covered folder (`mounts.refuses`) | unchanged; add a test |

### B. Folder and diff sets

| Call site | What it does | Today | After |
|---|---|---|---|
| `fs-scan-contained.ts` (21, 59, 85) | a folder bind's listing and `include` stat | `listTreeSync`, `guards.statSync` | unchanged |
| `folder-watch.ts` `walkListing` (254) | the folder watch's listing | `listTreeSync` when contained | unchanged |
| `fs-scan.ts` `readdirRecursive` (473) | the legacy walk | reached only when not contained | unchanged |
| `fs-scan.ts` `git ls-files`, `rev-parse` (198, 208, 275, 368) | listing a repo | barred | sandboxed git (section I); each name git prints must pass `namesOf`, since `admitGitListed` (244) joins it to the root as printed |
| `bind-diff.ts` `existsSync(root)` (162), read (359) | a diff bind | `existsSync` follows a link; the read is guarded | `existsTree` |
| `workspace-refresh.ts` `existsSync` (105, 204) | a refresh's "root missing" and "file gone" | follows a link | `existsTree` |
| `doc-store-workspaces.ts` (68, 347, 509, 604) | a set's root and its file reads | `guards.allows`, `boundFiles.read` | unchanged |
| `library.ts` (490), `routes/workspace-library.ts` (272) | the Library's file stat | `guards.statSync` | unchanged |
| `doc-image-versions.ts` (96) | an image's `?v=` stamp | `boundFiles.statMtime` → `tree-fs` | unchanged |

### C. Media and images beside a doc

| Call site | What it does | Today | After |
|---|---|---|---|
| `routes/review-raw.ts` `guardedBytes` (143) | a folder's video or image bytes | `guards.readRange` → `tree-fs` | unchanged |
| `routes/doc-assets.ts` `guardedImage` (125) | an image beside a bound doc | `readBytesChecked`: realpath, then open. A link that stays inside the root is followed (PR 1440 follow-up 4) | `readTree` on the `Contained` for `dirname(md)/segments` |
| `routes/doc-assets.ts` `resolveInside` (83) | where the image is | `realpathSync` in `doc-image-store.ts` (160–171), follows links | dropped when covered; `namesOf` refuses `..` before any I/O |
| `doc-image-store.ts` `storeImageBeside` (93–125) | an upload into `images/` | `realpathSync(docDir)`, then `mkdirSync(folder, {recursive})` by path, then `O_EXCL\|O_NOFOLLOW` on the last name. A swap between the realpath and the mkdir makes a folder outside before the check refuses it (follow-up 5) | `mkdirTreeSync` for `images/`, then a new `createTree` (`O_CREAT\|O_EXCL\|O_NOFOLLOW_ANY`, judged, then written by descriptor) |

### D. A doc's framed pages (`::html{src=…}`)

| Call site | What it does | Today | After |
|---|---|---|---|
| `doc-file-frame.ts` `readDocFile` (150–179) | a page's or asset's bytes | `realpathSync(root)`, then `readBytesChecked`, which follows a link inside the root | `readTree` |
| `doc-file-scope.ts` (84) | "is the page a file" | plain `stat`, follows a link | `statTree` |
| `doc-file-page-cache.ts` (55) | the page cache's stamp | plain `stat` | `statTree` |
| `doc-file-listing.ts` (71–75, 144) | the folder's git listing, and an `lstat` | git barred; `lstat` is a name check only | sandboxed git; the `lstat` becomes `existsTree` |

### E. Mocks

| Call site | What it does | Today | After |
|---|---|---|---|
| `mockup-capture.ts` `checkMockupSource` (87–100) | can the source be read | `existsSync`, `statSync`, `accessSync`, each following a link, before `landsAllowedSync` | one `guards.statSync`; the answer for a link is "refused path", the same as for a missing target |
| `mockup-capture.ts` `readMockupBytes` (127), `readMockupHtml` | the source's bytes | `guards.readBoundedBytesSync` → `tree-fs` | unchanged |
| `routes/shell-static.ts` `serveMockup` (349) | serves a non-HTML mock | through `readMockupBytes` | unchanged |
| `file-binding.ts` `attachMockupFile` (1212) | the mock's poll | `slow-fs` stat → `tree-fs` | unchanged |

### F. Mounts, conventions and meetings

A covered folder is never mounted, and a mount made there earlier lists and
serves nothing (PR 1423). These sites are contained by that refusal, made from
`covers` before any I/O.

| Call site | What it does | Today |
|---|---|---|
| `mount-store.ts` (227, 248, 370–377), `mount-scan.ts` (99, 128, 209), `routes/mount-file.ts` (120), `mount-reconcile.ts` (56) | a mount's listing, stat, bytes | refused when covered |
| `mount-store.ts` conventions (433) | the conventions index | `guards.readBoundedSync` |
| `routes/mounts.ts` meetings folder (353–357) | creates the meetings folder | `mounts.refuses` first |
| `meeting-home.ts` `applyMeetingGitignore` (145–183) | the meetings `.gitignore` | the home is never covered; `O_EXCL\|O_NOFOLLOW` |
| `doc-move.ts` (106, 182) | the target of a move into a mount | inside a mount only, so never covered |

After: unchanged, plus one test that a mount and a meetings folder inside a
root are refused before anything is made.

### G. Copies, repo identity and spellings

| Call site | What it does | Today | After |
|---|---|---|---|
| `doc-copies.ts` (91, 100) | hash of a doc's copy in another checkout | `guards.readSync`, `guards.statSync` when covered | unchanged |
| `doc-copies.ts` `git status` (122–125) | the uncommitted mark | barred | barred (sync, section I) |
| `doc-key.ts` `repoIdentityAt`, `docKeyForPath` (215, 276), `doc-origin-repo.ts` `findWorktreeRoot`, `gitCommonDir` (62, 114) | which repository a doc is in, and so its `docKey`, which is looked up across every board (`doc-store.ts` 2559–2571) | `readOriginUrl` is barred, but a lead's `.git` pointer file is read and followed. A root that is a worktree of the owner's repository therefore gets the owner repository's key, and a bind there can return the owner's doc of the same relative path on another board (review H1) | `findWorktreeRoot` and `gitCommonDir` answer null for a covered path, so `repoIdentityAt` and `docKeyForPath` are null. The bind mints a doc bound to that path alone, and `noteCheckout` and `mount-store.locate` record nothing |
| `git-hardening.ts` `repoOf`, `readLine` (86–145) | finds the repository for `gitBarred` | `lstatSync`, `realpathSync`, `readLine`; stops at a pointer under a root | `readLine` answers null for a covered path, so a `.git` file there is `refused` and the path stays barred |
| `doc-create-conflict.ts` (50), `safe-path.ts` (37, 61), `git-provenance.ts` (156) | a path's real spelling, to compare | `realpathSync` | unchanged. A spelling is the only output, and every read or write that follows the comparison goes through `tree-fs`. The cost left is the autofs hang listed under "What this does not close" |

### H. Watches

| Call site | What it does | Today | After |
|---|---|---|---|
| `dispatch-registry.ts` `fs.watch(worktreePath, {recursive})` (85), `existsSync` (230, 311) | notices a dispatch worktree changing | FSEvents on the path; no content read; follows a link at the top | unchanged. The watch reads no file, so a link there tells the server only when something outside changed. A lead's own worktrees are under its roots, so refusing covered paths would break the lead's dispatches |
| the bound-file poll | notices a file edit | `slow-fs` stat → `tree-fs` | unchanged |

### I. Git spawns

Every server git call, by grep for `spawnSync('git'`, `execFile('git'` and
`Bun.spawn([... 'git'`. Each one calls `gitBarred` first today. A synchronous
call holds the event loop for every board while git runs, so on a covered path
only the asynchronous ones become sandboxed git. The synchronous ones keep
"cannot tell" (review M3).

| Call site | Command | On a covered path, after |
|---|---|---|
| `activity.ts` (194–201) | `rev-parse --show-toplevel`, `remote get-url origin` | barred (sync; and an origin is never a key, rule 4) |
| `doc-copies.ts` (122–125) | `status --porcelain` | barred (sync) |
| `doc-identity-renames.ts` (44–48) | `log --diff-filter=R -M` | barred (sync) |
| `doc-file-listing.ts` (71–75) | `ls-files` | sandboxed |
| `fs-scan.ts` `scanFolderPathsAsync`, `repoKindAsync` (208, 270–275) | `ls-files`, `rev-parse --is-inside-work-tree` | sandboxed |
| `fs-scan.ts` sync paths (164, 198, 365–368) | the same | barred (sync) |
| `folder-watch.ts` (231–233) | `ls-files` | sandboxed |
| `git-diff.ts` `gitAsync` (57–59) | the diff review's reads | sandboxed |
| `git-diff.ts` `gitSync` (35–36) | the same | barred (sync) |
| `git-provenance.ts` (94–97) | provenance, the conflict hint and the uncommitted mark | barred (sync) |

Out of scope: `git-push/git.ts` runs git in a temp repository the server makes
from the lead's bundle, with the server's own config. A bundle carries no
config. `plugin-refresh.ts`, `deploy*.ts`, `dependency-install.ts` and the
keeper run in the owner's own checkouts.

### J. Backups and temp files

| What | Where | Today |
|---|---|---|
| a write-back's temp file | beside the target in the lead tree | `tree-fs` `writeTree`: random name, `O_CREAT\|O_EXCL\|O_NOFOLLOW_ANY`, judged, renamed by folder descriptor |
| clobber backups, live copies (`file-binding.ts` 2600–2712) | `<dataDir>/clobber-backups` | the content comes from a guarded read; the file is written in the data dir |
| pre-compact backups (`pre-compact-backup.ts`) | beside the `.ydoc` in the data dir | not a lead tree |
| `mockup-capture.ts` and `mockup-versions.ts` temps | data dir | not a lead tree |

PR 1440 follow-up 10 stays open: a temp is created by path and renamed by
folder descriptor, so a folder swap between those two steps can leave a temp
file behind. The fix is to create it with `openat` on the folder's descriptor,
which needs one more native call (`openat`) in `tree-fs-native.ts`.

### K. Server code that runs outside the server process

| Call site | What it does | Today | After |
|---|---|---|---|
| `bound-file-sync/doc-mirror.ts` (80–201) | board-sync's mirror of a moved board's doc to a `.md` on the Mac | plain `readFileSync`/`writeFileSync` on the mirror path; no guard installed in that process | `sync-bin.ts` installs `BoardSocketRoots` from `<CW_DATA_DIR>/board-socket-roots.json` on that process's `boundFiles.guards`, and the mirror reads and writes through the guards. Without `CW_DATA_DIR` it logs that paths are unchecked: a board-sync config predates this, and refusing to start would stop a sync the owner turned on |
| `scripts/lead-sandbox-git.ts` (15) | the launcher reads `core.hooksPath` | `git config --get`, which runs no program | unchanged; listed so the next reader does not have to check |

## Git, in detail

`gitBarred` stays the decision of whether a path is in a lead's repository.
`git-contained.ts` decides what an asynchronous caller gets there: a sandboxed
git, or "cannot tell".

**When git runs at all.** All of these must hold, or the answer is "cannot
tell":

- the platform is macOS and `/usr/bin/sandbox-exec` exists;
- `PathGuards.containedOf(cwd)` names a root;
- the repository is found inside that root: a `.git` folder, or a `.git`
  regular file whose `gitdir:`, read through `tree-fs`, names a folder inside
  the root. Each level from the working folder up costs one `tree-fs` open of
  its `.git` (`kindTree`), never a listing of the folder (round 2, M1). A `.git` link, a pointer out of the root, or no `.git` below the
  root (the root sits inside a larger repository) is refused;
- the root's text holds no `"`, `\` or control character, so it can be written
  into the profile as a literal.

**The profile.** The server writes it per call from the root, with no input
from the lead or its launcher. That is review round 1's M2, and it drops the
`profile` field the first draft added to the roots PUT. That field opened L3
(the profile file check tested the wrong thing), L5 (which profile to use when
two boards share a root) and L7 (a swapped working folder reaching any
repository the lead can read).

```scheme
(version 1)
(deny default)
(allow process-fork)
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (literal "/") (subpath "<root>") (subpath "<git prefix>")
                  (subpath "/usr/lib") (subpath "/System")
                  (subpath "/private/var/db/dyld") (literal "/dev/null"))
(allow file-write-data (literal "/dev/null"))
(allow process-exec (literal "<git binary>"))
```

Measured on this Mac (2026-11-04, Xcode's git and Homebrew git 2.54.0):
`rev-parse`, `status`, `ls-files` (with and without `--others`), `diff`,
`log` and `show` all succeed under it. Without `(literal "/")`, git aborts
at start (SIGABRT). It needs no `mach-lookup`.

The git binary comes from a fixed list, never from `xcrun` (review round 2,
H1): Xcode's git (`/Applications/Xcode.app/Contents/Developer/usr/bin/git`),
then the Command Line Tools' (`/Library/Developer/CommandLineTools/usr/bin/git`).
The first is used whose binary, and every folder from it up to its
`Developer` folder, is owned by root with no group or other write, and whose
path holds no link. The profile's read prefix (`…/usr`) comes from the same
list, so git's own `share/git-core` is readable. `xcrun -f git` and the
`/usr/bin/git` shim answer from `xcrun_db`, a per-user cache in the temporary
folder that a lead under the same user can write; a forged entry there is
honoured (measured in the round 2 review: a copy with git's path swapped made
`/usr/bin/git --version` run the copy's script).

The same cache chooses what every unsandboxed `/usr/bin/git` runs, so the
server (`bin.ts`), the git proxy and the lead launcher set `xcrun_nocache=1`,
which makes every Xcode shim skip it (measured: with it set, the forged entry
is ignored). The wall makes `xcrun_db` and its folder read only to every lead
(`xcrunCachePaths` in `scripts/lead-sandbox-owner-bins.ts`), so renaming the
folder away and putting a new one in its place is refused too.

**Subcommands.** A contained call runs only `ls-files`, `diff`, `rev-parse`,
`merge-base`, `status`, `config`, `cat-file` or `hash-object`, first in its
arguments (round 2, L3). Anything else, a global option first included, is
"cannot tell".

Under this profile, a program a hostile config names cannot start: exec is
allowed for the git binary alone, and Seatbelt checks an interpreter as well
as the script it runs (review P2). So hooks, `!` aliases and `fsmonitor`,
filter, `textconv`, `gpg` and pager commands all fail. `include.path`,
`core.worktree`, `objects/info/alternates` and every other file outside the
root read as missing. Nothing can be written. `GIT_CEILING_DIRECTORIES` is the
root's parent, so git does not look for a repository above the root.

**The environment** is fixed, and holds none of the server's variables
(review M1):

- `PATH=/usr/bin:/bin`, `HOME` and `XDG_CONFIG_HOME` set to `/var/empty`
  (root-owned), and `LANG=C`;
- `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_ATTR_NOSYSTEM=1`;
- `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0` and `GIT_NO_LAZY_FETCH=1`;
- `GIT_CEILING_DIRECTORIES`;
- the settings below, passed as `GIT_CONFIG_COUNT`.

**The time bound.** Every call is `execFile` with a timeout (30 s, as
`git-diff.ts` uses today), `killSignal: 'SIGKILL'` and a 64 MiB `maxBuffer`. A
killed call answers "cannot tell". There is no synchronous entry point.

**The neutralised settings** are a second line. They are passed through
`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`, which does
not split a key at `=` the way `-c` does (review L1):

- `core.fsmonitor=false`, `core.untrackedCache=false`,
  `safe.bareRepository=explicit` and `log.showSignature=false`;
- `core.hooksPath=/dev/null`, `core.pager=cat`, `core.editor=false`,
  `core.sshCommand=false`, `core.askPass=` and `credential.helper=`;
- `gpg.program`, `gpg.ssh.program` and `gpg.x509.program` all `=false`;
- `protocol.allow=never` and `core.alternateRefsCommand=`;
- the output pins (review L6): `core.quotePath=true`, `diff.noprefix=false`,
  `diff.mnemonicPrefix=false`, `diff.relative=false` and `color.ui=false`.

`git-contained.ts` adds `--no-ext-diff --no-textconv` after every diffing
subcommand (`diff`, `show`, `log` and the plumbing diffs). An empty
`diff.external`, `diff.<d>.command` or `diff.<d>.textconv` is not "none" to
git: it is a command git prepares temp files for and tries to run, which made
every `git diff` fail under the sandbox. So diff drivers are turned off by
those flags, and by the profile under them, not by a setting. Filter drivers
have names the repository chooses, and git runs no filter whose command is
empty. So the call is preceded by a sandboxed
`git config -z --name-only --get-regexp '^filter\.'`, and an empty value is
added for every `filter.<d>.clean`, `.smudge` and `.process`, plus
`filter.<d>.required=false`. A config changed between that read and the run
is still held by the sandbox.

**Git's output is the lead's text.** A crafted index can make `ls-files` print
`../x`. Every name git prints is checked raw, before `join` normalises it: an
empty, `.` or `..` segment, a leading `/` or a NUL drops it
(`admitGitListed`). Every later read of the name goes through `tree-fs`. No
output of a sandboxed git is used as a key or a registry entry (rule 4).

**Cost: about 5 ms per git process, and a contained call starts two** (the
filter listing, then the command), so about 10 ms per call. Measured on
2026-11-04 at 13:45Z, load average about 2.4, with Xcode's git, the
deny-default profile and `containedGitEnv`, `git status --porcelain` on the
same 200-file repo, 20 interleaved runs per arm after one warm-up, two runs:

| Arm | Median (run 1 / run 2) | p95 (run 1 / run 2) |
|---|---|---|
| plain git, `HARDENED_GIT_ARGS` | 5.4 / 5.4 ms | 6.4 / 6.3 ms |
| contained (`sandbox-exec -p`, fixed env) | 10.4 / 10.4 ms | 12.3 / 13.0 ms |

The first draft's measurement follows, kept because it is the one the review
read. It used Homebrew git, on 2026-11-04 at 12:59Z, with load average about 3. The command was `git status --porcelain` with
`HARDENED_GIT_ARGS` and `GIT_OPTIONAL_LOCKS=0`, using Homebrew git 2.54.0
resolved to its Cellar path, on a temp repo of 200 committed files with one
modified. Each arm ran 20 times after one warm-up, interleaved so that machine
drift hit all three arms alike. The profile was the one `buildProfile`
generates for a lead whose only project is that repo (108 lines). Two runs:

| Arm | Median (run 1 / run 2) | p95 (run 1 / run 2) |
|---|---|---|
| plain git | 8.2 / 8.2 ms | 9.2 / 9.4 ms |
| `sandbox-exec`, lead profile | 15.3 / 15.4 ms | 16.2 / 16.9 ms |
| `sandbox-exec`, lead profile + tail | 14.7 / 14.6 ms | 15.7 / 15.4 ms |

So the sandbox costs about 6.5 ms per call at the median and about 6–7 ms at
p95, and the tail adds nothing measurable. `git status` succeeded under the
tail's write deny, which shows that `GIT_OPTIONAL_LOCKS=0` is enough for it to
write nothing. The cost does not depend on repo size; it is the cost of
starting a sandboxed process. A diff review that runs ten git calls pays about
65 ms more, and the folder listing caches its answer. The benchmark script is
not in the repo, and no test asserts a timing.

## What `tree-fs.ts` gains

- `existsTree(c)`: true when the path opens as `tree-fs` would open it;
  false for a missing name; a link, a FIFO or a second name is a refusal,
  not "missing".
- `createTree(c, bytes)`: a new file, `O_CREAT|O_EXCL|O_NOFOLLOW_ANY`,
  judged, then written by descriptor. The image upload uses it, through
  `PathGuards.createNewSync` and `doc-image-store.ts` `storeImageInTree`.
- `PathGuards.exists`, which sends a covered path to `existsTree` and any
  other path to `existsSync`. A link anywhere on a covered path answers
  "present", whatever it points at, so the answer never says whether a file
  outside exists.
- `PathGuards.readBytes(path, max)`: a covered path's bytes and stat, through
  `readTree` where a root holds it, and the checked read for the owner's part
  of `~/.claude`; null for an uncovered path. `doc-assets` and
  `doc-file-frame` use it in place of `readBytesChecked`.

`tree-fs.ts` was at 491 lines, so the new calls go in a sibling,
`tree-fs-create.ts`, which reaches the shared pieces through
`treeInternals`. The export took `tree-fs.ts` to 504; it has a `Split` row in
`exceptions.md` naming the writes as the next seam.

## The helpers fail closed

Each helper below can be called without importing `node:fs`. Each now checks
whether the path is under a root (`PathGuards.heldByRoot`, true in every
`treeFsMode`) and refuses it itself (review M4).

| Helper | Under a root |
|---|---|
| `readChecked`, `readCheckedSync`, `readBytesChecked`, `readRangeChecked`, `statChecked`, `writeChecked`, `writeCheckedSync` (re-exported from `bound-path-guard.ts`) | throws `GuardRefused` itself (`refuseRootPath` in `bound-path-checked.ts`, asking `bound-root-view.ts`). On macOS `PathGuards` sends a root's path to `tree-fs` before it reaches them; off macOS, where `PathGuards` calls them with its own landing check, they skip the refusal. The gate allows only `bound-path-guard.ts` to import `bound-path-checked.ts` |
| `nearestRealpathSync` | unchanged: it returns a spelling and no content, and `landsAllowedSync` needs it (see "What this does not close") |
| `readLine` (`git-hardening.ts`) | null |
| `statStampSync` (`file-stamp.ts`) | the stamp from `guards.statSync`, which goes through `tree-fs` |
| `findWorktreeRoot`, `gitCommonDir` (`doc-origin-repo.ts`) | null |
| `@claude-workspaces/core/safe-file` | a gate trigger. `packages/core` cannot see the roots, so every server module that imports it has a row saying which paths it passes |

## The gate

`scripts/check-tree-fs.ts`, a member of `bun run verify` and a step of CI's
`gates` job. Its table, `scripts/check-tree-fs-table.ts`, holds every module
in `packages/server/src` and `packages/core/src` (tests excluded) that imports
`fs`, `fs/promises` or `child_process` in any spelling (static, `import()`,
`require()`), uses `Bun.file`, `Bun.write` or `Bun.spawn`, imports
`safe-file`, or calls a checked helper or `readLine`: 180 today. The labels:
`tree-fs` (reaches a lead tree only through `PathGuards`, `tree-fs.ts` or
`git-contained.ts`), `refused-when-covered` (asks `covers` or `gitBarred`
first), `spelling-only` (section G's `realpath` comparisons), `never-covered`
(section F), `watch-only` (section H), `data-dir`, `owner-checkout`, `no-path`
(a process it hands no path, such as tmux and ps in `lead-chat/pane.ts`), and
`not-in-inventory`. The last covers 129 modules: the inventory's grep found
no path by which they act on a lead tree, and this work did not otherwise
audit them; a module added later needs a label someone chose for it. A module
missing from the table fails the gate, and so does a row for a module that no
longer reaches a file or no longer exists. The gate also fails any module
but `bound-path-guard.ts` that imports `bound-path-checked.ts`, and any module
but `tree-fs-create.ts` that names `treeInternals`. The labels are claims a
reviewer reads, not proof.
What the gate guarantees is that a new module cannot get file or spawn access
without someone writing down why. It keys on imports, not on variable names
(PR 1440's L6).

## The tests

Each test plants a link, a hard link or a git setting in a temp dir registered
as a root, and never uses a real lead's folder. For each one, the "base" column
says what happens at 3413ccb27. Three kinds:

- **Base**: the escape works on origin/main, and the test fails there.
- **Unbarred**: on base, git does not run here at all. The control arm runs
  the same command as plain git, as an owner's shell would, and shows that
  the planted program runs or the outside file is read. The contained arm
  shows that it does not, and where a row says so, one layer is turned off
  (`setContainedGitLayersForTest`) to show the other holds alone.
- **Race**: the swap must land between two calls. The test uses a seam
  (`setTreeSeamForTest`, or a new seam where named). Its control is a
  mutation run: remove the check and confirm that the test fails.

| # | Test file | Planted | Base | Proves after |
|---|---|---|---|---|
| 1 | `lead-tree-assets.test.ts` | `img/a.png` → a link to `other/a.png` inside the root; a plain `img/plain.png` as the control | Base: served (fails at 3413ccb27's `routes/doc-assets.ts`, checked by putting that file back) | 404, no bytes; the plain image is served |
| 2 | same | `hard.png` hard-linked to a file outside | Base: refused (`nlink`). This is the control | still refused |
| 3 | same | the doc's folder swapped for a link to an outside folder from `setTreeSeamForTest`, during the upload | Race. At base the upload takes no `tree-fs` path, so the seam never fires; the test fails there on that, not on an escape | 409, and the outside folder stays empty |
| 4 | same | `images` planted as a link to a folder inside the root; a plain upload as the control | Base: refused after the mkdir | 409, nothing stored in the link's target; the plain upload stores its file |
| 5 | `lead-tree-helpers.test.ts` | a framed page's `linked.css` as a link inside the root; a plain `style.css` | Base: both 404, since git is barred and nothing is git-listed | the plain file is served, through contained git listing it; the link is 404 |
| 7 | same | a covered name as a link to an outside file that exists, and as a dangling link | Base: `existsSync` answers differently for the two | `guards.exists` answers the same for both; a plain file and a missing name answer true and false |
| 8 | same | a mock source as a link to an outside file that exists, and one that does not | Base: "refused path" for one, "unreadable" for the other | the same reason for both; a plain source is ok |
| 9 | same | a bound file as a link to an outside file of a known size | Base: `statStampSync` reports the outside size | refused; a plain file's size is read |
| 10 | `git-contained.test.ts` | `core.fsmonitor` = a script that writes one marker inside the root and one outside | Unbarred: plain git writes both markers, and so does this module with both layers turned off | with the sandbox alone, git answers and neither marker is written (review L4) |
| 11 | same | `filter.<d>.clean` plus a `.gitattributes` line, for a driver named `x` and one named `a=b`, then `git diff` | Unbarred: the markers are written | no marker with the sandbox alone, none with the settings alone, and `git diff` succeeds with both (review L1) |
| 12 | same | `diff.t.textconv`, a `!` alias, `gpg.program` with `log.showSignature`, and `core.pager` | Unbarred: the textconv and the alias write their markers | no marker, with the sandbox alone and with both layers |
| 13 | same | `include.path` naming a config file outside the root that sets `riverbend.leak` | Unbarred: `git config` reads it | the value is not read |
| 14 | same | `objects/info/alternates` naming a repository outside the root, and an object only it holds | Unbarred: `git cat-file -p` prints it | the object is missing |
| 15 | same | the working folder swapped for a link to another repository from `setContainedGitSeamForTest` | Race; plain git through the link lists the other repository | git lists nothing from it |
| 16 | same | `GIT_DIR` and `GIT_CONFIG_PARAMETERS` in the test's `process.env`, pointing at another repository and a setting | Unbarred: `hardenedGitEnv()` drops `GIT_*`, but passes every other variable | the root's files are listed and the setting is not read; `containedGitEnv` holds only the fixed keys (review M1) |
| 17 | same | `git hash-object` on a FIFO, with a 300 ms bound | Unbarred: nothing bounds a sync call | "cannot tell", and an interval timer fires while it waits (review M3) |
| 18 | same | a `.git` link, a `.git` file pointing out of the root, and a root inside a larger repository | Base: barred | "cannot tell" for each; plain git in the third lists the outer repository |
| 19 | `lead-tree-helpers.test.ts` | `isSafeGitName` given `../outside.md`, `/abs.md`, `a//b.md`, `a/./b.md`, `a/../b.md`, `''` and a NUL | Base: no check | each is dropped; `docs/plan.md` and `.github/x.md` pass (review L6) |
| 20 | same | a root that is a `git worktree add` of a repository with an origin | Base: the worktree shares the owner repository's key (the control, asserted before the root is registered) | under a root, `findWorktreeRoot`, `gitCommonDir`, `repoIdentityAt` and `docKeyForPath` are null (H1) |
| 21 | `bound-file-sync.test.ts` | a mirror path under a registered root, with its file a link to an outside file | Base: the mirror writes through the link (checked by putting 3413ccb27's `doc-mirror.ts` back: no refusal is logged) | the write is refused and logged; the outside file and the link are unchanged |
| 22 | `mount-store-walled.test.ts` (unchanged) | a mount inside a root | Base: refused. This is the control | refused |
| 23 | `scripts/check-tree-fs.test.ts` | fixture modules importing `node:fs`, calling `readLine` with no `fs` import, with `import('fs')`, one in `packages/core/src`, one importing `bound-path-checked.ts`, one naming `treeInternals` | n/a, new gate | each fails the gate; each passes once its row is added; a module that reaches nothing needs no row (review M4) |
| 24 | `lead-tree-helpers.test.ts` | each helper in "The helpers fail closed", called on a file under a registered root | Base: each reads or writes it | each refuses; the same helpers read a plain file |
| 25 | `board-socket-lead.test.ts`, `board-socket-lead-writes.test.ts`, `walled-folder-bind.test.ts` (unchanged) | none | the lead's folder bind, doc list and set-content work on its own board and are refused on another | unchanged; re-run as the regression |
| 26 | `git-contained-binary.test.ts` | an owner-writable git listed before the root-owned ones, and one reached through a link | Base: `xcrun`'s answer is trusted, whatever the cache names | both passed over; the root-owned git runs and the forged one never does; with only the forged one listed, "cannot tell" |
| 27 | `git-contained-binary.test.ts` | a repository three folders above the working folder, beside 200 files | Base: every level is listed (`listTreeSync`) | found with no listing (a spy on `listTreeSync` sees none) |
| 28 | `lead-sandbox-owner-bins.test.ts` | a stand-in `xcrun_db` and its folder, under the real `sandbox-exec` | Base: the lead's write lands (the mutation control) | the write and a rename of the folder are refused; other files there and the project still write |

Test 6 of the first draft (a framed page's folder renamed out during the
read) is covered by `tree-fs.test.ts`'s folder-moved case, which every read
here goes through; it is not repeated.

Tests 10 to 18 run under the real `sandbox-exec`, so they run on darwin only,
as `walled-folder-bind.test.ts` does. On Linux one case shows git stays barred
there.

## What this does not close

- **`realpath` on a covered path.** The comparisons in section G, and
  `rootFor` at a lead's bind (PR 1440 follow-up 3), still call `realpath`. It
  returns a spelling and no content, but it can hang on an autofs path. The
  fix is a text comparison first; it is not in this work.
- **A stall, not an escape.** A lead bind still walks up to 200k entries on the
  main thread (follow-up 2), and the native calls are synchronous (PR 1440's M2). This
  work changes neither.
- **Case and Unicode spellings** of one APFS file still become separate doc
  ids (PR 1440's L3).
- **A hard link made before walling.** Seatbelt judges the path opened, so a
  hard link inside the root to a file outside it is readable to contained git,
  and `git diff` would print it. `tree-fs`'s `nlink == 1` check does not apply
  to git. The wall refuses making such a link (round 2, P6), so this needs one
  that existed before the lead was walled (round 2, L7).
- **The owner's own sessions.** A hook or MCP child in the owner's
  unsandboxed session that reads a lead's project is not server code. PR
  1423's O2 (shared transcripts and memory) stays open.

## Call sites that change, in build order

1. `tree-fs-create.ts`: `existsTree`, `createTree`. `bound-path-guard.ts`: `exists`, `readBytes`, `heldByRoot`, and the fail-closed exported helpers.
2. `file-binding.ts`, `bind-diff.ts`, `workspace-refresh.ts`, `doc-store.ts`, `doc-store-workspaces.ts`, `doc-file-listing.ts`: `existsSync` → `guards.exists`. `file-stamp.ts` → `guards.statSync`.
3. `routes/doc-assets.ts`, `doc-file-frame.ts`, `doc-file-scope.ts`, `doc-file-page-cache.ts`: reads and stats through `guards.readBytes` and `guards.stat`.
4. `doc-image-store.ts`: `mkdirTreeSync` + `createTree`.
5. `mockup-capture.ts` `checkMockupSource`: one guarded stat.
6. `git-hardening.ts` `readLine`, `doc-origin-repo.ts` `findWorktreeRoot` and `gitCommonDir`: null for a covered path (H1, M4).
7. `bound-file-sync/sync-bin.ts` and `doc-mirror.ts`: the guards installed, and the mirror's I/O through them.
8. New `git-contained.ts`: the run conditions, the profile, the environment, the settings, the driver read and the async spawn. `git-diff.ts` `gitAsync`, `fs-scan.ts` async paths, `folder-watch.ts` and `doc-file-listing.ts` call it; `admitGitListed` checks raw names.
9. `scripts/check-tree-fs.ts` and its table; `scripts/verify.ts` and ci.yml.
10. `security.md` and `overview.md` updated; this doc added to the CLAUDE.md list.

## Review round 1, finding by finding

| Finding | Where it is handled |
|---|---|
| H1, a lead's origin becomes a global doc key | rule 4; section G; test 20 |
| H2, `/opt/homebrew` writable under the wall | out of scope (the wall); another builder holds it |
| M1, the server's environment reaches git | "The environment"; test 16 |
| M2, deny-default profile | "The profile"; tests 10–15 |
| M3, synchronous git with no bound | "The time bound"; section I; test 17 |
| M4, helpers and `packages/core` outside the gate | rules 5–6; "The helpers fail closed"; tests 23–24 |
| L1, `-c` splits at `=` | `GIT_CONFIG_COUNT`; test 11 |
| L2, two existence checks missing | section A; build step 2 |
| L3, the profile check tested the wrong thing | the `profile` field is dropped |
| L4, markers only outside the root | tests 10–12 write inside markers |
| L5, a root on two boards | the profile is written from the root, so no board has to be chosen |
| L6, git's output format is the lead's | the output pins; raw-name check; test 19 |
| L7, the working folder can be swapped | the profile reads the root only; test 15 |
