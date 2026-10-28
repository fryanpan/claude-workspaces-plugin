# Project: claude-workspaces-plugin

Make giving feedback to LLM agents as fast as pointing and saying "this" —
real-time iteration across three review surfaces: markdown + diagrams, UX
mockups, and live dev servers, with comment threads that survive edits. Read
[docs/product/vision.md](docs/product/vision.md) before non-trivial work, and
[docs/product/priorities.md](docs/product/priorities.md) before ranking any
work against other work.

**Stack:** TypeScript + Bun server; Cloudflare Tunnel; the injectable widget
is vanilla JS / web components only (no framework deps — it must not conflict
with host sites); agent integration is MCP tools + HTTP webhooks. TypeScript
strict mode. Widget bundle size is a hard constraint — measure and report it
on every PR that touches widget code.

## Architecture summaries — linked, never inlined

Start at [overview](docs/architecture/overview.md) — the packages, the layers
inside each and which way imports may point, plus the main data flows. Read it
before non-trivial work.

Per-subsystem summaries live in [docs/architecture/](docs/architecture/):
[meeting-assistant](docs/architecture/meeting-assistant.md) (live
transcription + notes on a pause-or-cadence clock),
[stall-check/](docs/architecture/stall-check/README.md) (the design, what
"working" means, per-module criteria; the mechanics are
[stall-detection](docs/architecture/stall-detection.md)),
[goal-projection](docs/architecture/goal-projection.md) (the goal bar, the
remainder, and when a goal lands),
[scheduled-tasks](docs/architecture/scheduled-tasks.md) (a row's rule for when
its work starts, and the loop that files each occurrence),
[unfiled-ask](docs/architecture/unfiled-ask.md) (whether a closing message
asked the owner something with nothing filed, and the measured rates at which that
judgement is wrong),
[scrub-name-finder](docs/architecture/scrub-name-finder.md) (the free pass
that picks which pushed lines Haiku reads, its measured recall, and the
names it never sends),
[supervisor](docs/architecture/supervisor.md) (the health check that decides
prod's server is dead, why its budget is 75s and a first bind's is 240s, the
three-per-hour restart limit, and the 16 September outage worked through),
[voice-conversation-api](docs/architecture/voice-conversation-api.md) (the
OpenAI-format protocol any app uses to talk to one agent, its token, and why
it streams with a 180s bound),
[app-voice](docs/architecture/app-voice.md) (how a sandboxed mock or app
proves it is one doc on one board, so it can speak, listen and write through
its own socket) and
[security](docs/architecture/security.md) (trust boundaries, the gates that
enforce them, where secrets live, the deploy and webhook surfaces). Read the
relevant one before touching its subsystem.
Deliberately not `@`-imported — they cost no context until needed; keep it
that way and add new subsystem docs to the list here.

## Conventions

- Lead with goals, not implementation, in top-level docs.
- Public repo, branch protection on main — all changes via PR.
- **Never hard delete user content — soft delete** (the owner, 2026-08-17,
  project-wide). The `.ydoc` is the durable record analyses are rebuilt from.
  Use `archive_attachment_set` / `archive_doc` (reversible); `delete_doc` and
  `purge:true` destroy — calling them is a decision, never a default.
  Transient files (old releases, `.tmp`) are correctly hard-deleted.
  Mechanics and which verb does what: grep learnings.md "Soft delete".
- When narrowing an existing verb, keep accepting the old payload if a caller
  exists that you cannot restart — the shared server's REST routes. The owner
  waived compatibility shims for prototype-phase surfaces (2026-08-18).
- **Don't append CSS at EOF of any stylesheet under
  `packages/workspaces-app/src/`** — put rules in the
  `/* ===== SECTION ===== */` banner they belong to. The board's rules live in
  `board.css`, under the per-surface `/* ##### BOARD · … ##### */` sub-banner that
  names the surface (`grep -n '##### BOARD' packages/workspaces-app/src/board.css`
  lists them); the review editor's live in `doc.css`; `styles.css` keeps only
  the chrome all three pages share. The test for which file is **which pages
  can reach the rule**, not which surface it looks like — `.thread-line` reads
  as diff chrome and the board renders it too, so it stays in the base. Link
  order is load-bearing and measured: `board.css` BEFORE `styles.css`, `doc.css`
  and `signin.css` AFTER it, `tokens.css` last. Parallel branches that both
  append at EOF conflict every time.
- **Edit the owner's bound docs directly; don't default to `suggest: true`.**
  Concurrent editing is the norm; reserve suggestions for judgment calls.
- **Calm by default** (the owner, 2026-09-13): spend the reader's limited
  attention only where it pays. No pulsing, no blinking, no badges; a steady
  indicator (the red Recording dot) is clear enough.
- **A UI element keeps its size and position as its state changes** (the owner,
  2026-09-17), unless the change is the thing the reader has to notice. Size a
  control for its widest option and keep the part of its label that does not
  change in the same place, so nothing beside it moves and the reader's target
  stays where they aimed.
- **Every surface is live** (the owner, 2026-10-08): the whole product is
  real-time multiplayer. Any page open on the board, Home, the workspaces
  list, a doc, a task, a goal, a mock, a diff or a folder shows a change made
  anywhere else, by a person or an agent, within 1s and without a reload. New
  functionality ships with its live path (a stream or Yjs subscription that
  updates the view in place) and a test that a change made elsewhere reaches
  an already-open page. A page rendered once on the server and never updated
  is a bug.
- **Verify UI at 1180x820 (iPad landscape — the owner's main device) AND 430px**
  per [docs/product/design-mobile.md](docs/product/design-mobile.md). Tiers:
  mobile ≤1100, tablet/laptop 1101–1920 (iPad and MacBook alike — the scarce
  axis there is HEIGHT, ~750px usable), 4K above. Width cannot identify a
  device (zoom moves it): per-device truth goes in a stored preference, never
  a media query. Grep learnings.md "zoom" for the measured failures.
- PR after each task is done; a cohesive feature is ONE PR with ordered
  commits, not a fragment per file.
- **Mockups and sketches never enter the repo** — write the HTML outside the
  working tree and serve it with `attach_mockup(docId, sourceHtmlPath)`.
- **A mock of a change to an existing surface starts from that surface.** Take
  the real markup and stylesheets off a `bun run staging` run, add the change
  in place, and keep the flow the reader already uses. A fresh design is only
  for a surface that does not exist yet.
- **Mocks are interactive.** The reader reaches every state by acting on the
  page — tapping, typing, moving — never by reading a strip of captioned
  scenes.
- **One mock per surface, changed in place.** Each round edits the file the
  existing mock serves from (a reload shows it), keeps the elements the
  reader's comments point at, and answers on the reader's thread there. Never
  a new mock doc, a new link or a new review item per round (the owner,
  2026-09-14: "there should be one collaboration surface").

## The gates — `bun run verify` before you push

```bash
bun run verify                        # every gate CI runs. ~2 min, cheapest first.
bun run verify --list                 # the members, and the one hole
bun run verify --only lint,typecheck  # re-run what failed
bun run verify --bail                 # stop at the first failure
```

**One command, not a list you pick from.** This section used to name four
gates. CI runs every gate `bun run verify --list` names, and a builder who
ran the four and pushed went red on `loc:audit` — a doc comment had taken a
file from 496 to 504 lines. A list drifts the moment somebody adds a CI step;
`bun run verify` is the set, `scripts/verify.ts` is where it is written down,
and `bun run verify:parity` — a member of the run AND a step of CI's `gates`
job — fails if ci.yml gains a gate that is not a member, in ANY of its jobs.
That is what keeps this paragraph true.

CI is four jobs (`gates`, `client`, `server`, `coverage`) so that a verdict
takes about ninety seconds rather than eleven minutes; `bun run verify` is
still one sequential run, because this machine hosts several agents at once.
Its last three members are a chain — both suites run under coverage
instrumentation and `coverage` ratchets what they left in `.coverage/`, so
neither suite runs twice. `bun run test:server` splits the server suite across
four processes for the same reason CI splits it across eight: it is two-thirds
idle. Pass `--jobs 1` for the old one-process behaviour.

Every member's output goes straight to your terminal in full; the summary at
the end indexes that scrollback rather than replacing it. Nothing is piped, so
nothing swallows an exit code, and a member killed by a signal counts as a
failure rather than as a pass.

**The one gate it cannot run** is the concurrent-PR half of
`check:plugin-version`: asking GitHub what version every other open PR
declares needs a token and a PR number. `--list` names it as a hole rather
than leaving it an absence.

What a test has to do to be worth its runtime — behaviour not source shape,
poll-until not sleep, no wall-clock assertions — is
[.claude/rules/testing-standards.md](.claude/rules/testing-standards.md),
whose mechanical half is the `test:audit` member. The other bars — 500-line
files, strict types, the security-review trigger — are
[.claude/rules/code-health.md](.claude/rules/code-health.md), one enforcing
command named per bar.
`bunx biome check --write` fixes formatting; `any` and unused imports are
lint errors, at zero today. Per diff: `packages/plugin/**` → version bump
(below); `packages/mcp/src/**` needs no extra step of yours — the
`check:mcp-bundle` member rebuilds the bundle and fails until you commit it.

## Releasing the plugin

The full delivery model is [docs/process/delivery.md](docs/process/delivery.md)
— read it before answering "why doesn't my peer / my browser have this yet".

- Diff touches `packages/plugin/**` → bump the patch in THREE places, same
  value: `packages/plugin/.claude-plugin/plugin.json`,
  `.claude-plugin/marketplace.json`, and `PLUGIN_VERSION` in
  `packages/mcp/src/mcp.ts` (the handshake literal — the site that actually
  drifts; asserted by launcher.test.ts only after `bun run build:mcp`).
- **Bump nothing when the diff touches neither `packages/plugin/**` nor
  `packages/mcp/src/**`** — a needless bump manufactures a total merge order
  across unrelated branches.
- CI: `check:plugin-version` fails a plugin PR that doesn't move the version
  past origin/main, and checks other open PRs for the same number (lowest PR
  number holds it; a failed lookup SKIPS LOUDLY — read the log). Merge in
  ascending version order. Story: delivery.md "Version numbers collide".
- CI rebuilds `packages/plugin/mcp/index.js` and fails on drift. **Never
  hand-resolve its merge conflicts** — take either side, `bun run build:mcp`,
  commit the result.
- Delivery: prod refreshes the plugin cache itself (≤30 min, or
  `request_plugin_refresh`); a peer's SESSION restart is the peer's own step,
  and the order is update THEN restart. Manual update: `command claude plugin
  update claude-workspaces@claude-workspaces` (bare `claude` is a shell
  wrapper that mangles subcommands).
- The board's presence strip names which ATTACHED sessions are behind; an
  empty `behind` list is never fleet-wide clearance.

## Owner's machine-only rules

The owner's machine-only rules (deploying prod, where prod lives, Linear,
Sentry watches, Notion) are in the gitignored `CLAUDE.local.md` at the repo root.

## Staging — review a branch before merge

`bun run staging` from a LINKED worktree (it refuses the primary checkout —
the guard is `--git-dir == --git-common-dir`, and it still holds: prod no
longer deploys from there, but building bundles in the primary working copy
is its own accident): :8788, throwaway data dir; prod stays on 8787. Agent:
`FEEDBACK_BASE_URL=http://<host>:8788` at launch; data never migrates to prod.

## Leak gates (public repo) — one at commit, one at push

**`.githooks/pre-commit` judges the staged diff's ADDED lines only**
(`scrub-check.py --staged-added`) and blocks the commit before anything is
written, because that is the last point where the fix is an edit rather than a
history rewrite — and rewriting history is the step the permission classifier
refuses an agent. Editing a file whose UNTOUCHED lines already carry a match is
not refused; that is the point, and widening it back to whole blobs is how a
gate becomes a tax people turn off. Merge commits are skipped (their staged
diff re-presents everything the other parent carried); the push gate reads them
with `--cc`.

`.githooks/pre-push` runs a regex scanner (denylist + registry project names)
on every push, and a Haiku scanner only on pushes to fryanpan-owned remotes
(`SCRUB_HAIKU_FORCE=1` forces it elsewhere). Haiku reads only the lines a
free local pass flags as carrying a word, number or key the repository has
not already published, with two lines of context; a push with none makes no call, and a
name built from already-public words is never judged
(`SCRUB_HAIKU_RULES=off` sends the whole push). The Haiku key's daily spend cap
is shared with other repos on the machine (`SCRUB_HAIKU_DAILY_USD`, ledger
`SCRUB_HAIKU_SPEND_LOG`); a cap hit or a ledger it cannot read or append to makes no call and
blocks like any other could-not-run case — `scrub-haiku.py --spend-report`
says who spent it. One config source resolving
without the other FAILS the push (exit 2 — broken install); neither resolving
skips cleanly (`SCRUB_REQUIRE_SOURCES=1` makes even that hard). The scanner
takes paths / `--diff-range` / `--staged` and ignores stdin (piping scans
nothing, exits 0). Git-addressed modes scan the PUSHED BLOB, not the working
tree; `.ydoc`/`.jsonl`/`.csv`/`.svg`/`.xml`/images/extension-less files are
always scanned and cannot be allowlisted; `scrub-allow` counts only as a
trailing comment. Push findings name the commit that wrote each line — the
remedy is a rewrite only for one this push publishes, a forward commit for one
already on the remote.

**Write Harborlight, Riverbend or Saltmarsh where a real name would go.** They
are the house fixture names — invented place-words for a test fixture, a mock
payload, a doc example, a sample transcript — and the Haiku scanner is told
about them as placeholders beside Alice and Bob, so a push carrying one is not
blocked. One list, `HOUSE_FIXTURE_NAMES` in `scripts/scrub_names.py`, which
`scrub-haiku.py` renders into the prompt: the half that tells you to write them
and the half that decides whether they may be pushed cannot drift apart. They
did drift once. A push carrying `Saltmarsh` in a test constant was blocked as a
surname used as sample data, and because the gate reads every added line of the
UNPUSHED RANGE a forward commit does not clear it — the branch had to be
rebuilt as one commit and lost its ordered history. The exemption is those
three words, plus Alice and Bob (`PLACEHOLDER_NAMES`, beside it), and nothing
wider: the free pass never sends a line new only for one of those five, and a
Haiku block naming only them is overridden. Any other unfamiliar surname is
still a leak in a fixture, and `bun run scrub:recall` is what says so rather
than this sentence.

Setup once: `git config core.hooksPath .githooks`. Until then the clone is
unprotected and looks identical to a protected one; `bun install` warns
(`bun run check:hooks` asks directly). Both hooks share one config source and
one self-test: `bun run check:scrub-gate` (pre-commit runs its `--only commit`
subset). Bypass sparingly: `SCRUB_SKIP=1`, or `SCRUB_SKIP_HAIKU=1` for Haiku
alone.

## Learnings archive — grep it, don't load it

`docs/process/learnings.md` is the incident archive, deliberately not
`@`-inlined (~41k tokens). Grep it before acting when: something looks broken
or impossible; a check reports clean and you're about to trust it; a plugin
update or deploy seems unlanded; you're about to delete, overwrite, restore,
or force anything; CI is red on something your diff never touched.

```bash
grep -n -A12 -i '<topic>' docs/process/learnings.md
```

**Promotion rule:** anything that must fire *without* being looked up gets
promoted into this file or `.claude/rules/`; the promoted set stays under
~1k tokens total.

Promoted killer items (the archive has the full stories):

- **Bound docs make git operations lossy while live** — a git write to a
  bound file is an editor save; the doc wins and reasserts ~800ms later while
  git exits 0. Let bound docs idle ~1s before git ops; never Write/Edit a
  bound `.md` — MCP edit tools only.
- **A conflicted PR has ZERO check-runs** — `mergeStateStatus: DIRTY` + 0
  checks means merge main into the branch, not "CI hasn't started".
- **Check which tree you're in before writing** — `git rev-parse
  --show-toplevel`; a shell whose worktree was deleted silently lands in the
  primary checkout, prod's deploy source.
- **A negative probe needs a positive control**, and reproduce a reported
  impossibility before building the fix — task premises have been false.
