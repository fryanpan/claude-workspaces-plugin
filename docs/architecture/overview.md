# Architecture Overview

## **Goal:** Make it easier to explore ways for human(s) to work with a team of agents to do work.

It's built on a few guiding principals or observations:

- Built for Bryan and his side projects / fractional gigs
  - *Approach*: *Start with a [local-first](https://www.inkandswitch.com/) approach that lets one primary user iterate faster with their agent fleet*
  - *Caveats: This system may or may not work for how you want to work!*
- A team of humans & agents benefit from knowing the same shared context
  - *Approach: Real-time, multiplayer space to share knowledge and streamline all important work*
- Existing APIs (and MCP) in legacy systems are evolving too slowly to explore
  - e.g. in Notion, Asana, Confluence, Jira, Linear, Figma, Github, Zoom, etc.
  - Integrating with each of these and across multiple legacy systems slows agents down
  - *Approach: Keep moving critical workflows into the workspace and synchronize with legacy tools as needed*
- Human input to make consequential decisions is becoming even more important, not less
  - *Approach*: *Make human decisions first class citizens in the architecture and make them pervasive*
  - *Approach: Try to give humans the ideal user interface where they can make decisions, in context, and just point at something and give feedback with minimal overhead*
- When our main work is review and making decisions, that work can be done from anywhere
  - *Approach: Everything works on the go from a phone, tablet, or laptop or at home on a desktop* 

## Workflows Covered by Workspaces

This project started first as a way to give real-time synchronous document, mockup, and dev server feedback between one human and a Claude Code agent.  

Over time, we've evolved this to try to cover all of these workflows and decision types in an integrated way:

- Setting goals
- Research and planning
- Prioritization against goals
- Gathering human feedback on decisions, docs, code diffs, mockups, or running apps(the original intent of this repo)
- Building, testing, peer reviewing, and deploying software products
- Having discussions

There are lots of similarities between this tool and [Claude Desktop](https://claude.com/product/claude-code), [Claude Design,](https://claude.com/product/design) [Nimbalyst](https://nimbalyst.com/), [Conductor](https://www.conductor.build/), [Ink & Switch](https://www.inkandswitch.com/), [Fireflies](https://fireflies.ai/lpv/g110-fireflies), [Notion](https://www.notion.com/), but all of these other tools are inflexible and have major gaps for my workflow.

**Goal:** one person and a team of agents share one live workspace — docs,
mockups, dev servers, a board, meetings — so giving feedback is as fast as
pointing at a thing and saying "this". Why that is worth building is
[docs/product/vision.md](../product/vision.md); this page is only how the code is
arranged. Read it before non-trivial work.

## The packages, and what is inside `server`

```mermaid
flowchart TB
  subgraph browser[Browser]
    app["workspaces-app<br/>8 bundles: doc · board · settings · signin · landing · reviews · whiteboard · sentry"]
    wid["widget<br/>injectable web component"]
  end
  plug["plugin<br/>skills · hooks · bundled mcp"]
  mcp["mcp<br/>stdio MCP server"]
  subgraph srv["server — one Bun process"]
    edge["HTTP edge<br/>server.ts · routes/ · middleware/ · shells.ts · app-waiting-page.ts · member-home.ts<br/>request-admission · request-attribution · board-sockets<br/>socket-handlers · server-options · feature-module<br/>connector/ (hosted MCP at /mcp)"]
    docs["Doc store and attachments<br/>doc-store.ts · binds.ts · file-binding.ts · file-stamp.ts · flat-text-patch.ts<br/>doc-*.ts · doc-origin-repo.ts · doc-key.ts · repo-registry.ts<br/>repo-registry-file.ts · repo-registry-checkouts.ts<br/>doc-thread-merge.ts · doc-identity-plan.ts · doc-identity-migration.ts<br/>doc-identity-renames.ts · doc-identity-journal.ts · doc-identity-check.ts<br/>attachment-backfill.ts<br/>note-list-gap-repair.ts · note-list-gap-corpus.ts<br/>mount-registry.ts · mount-registry-file.ts · mount-scan.ts<br/>mount-reconcile.ts · mount-store.ts · attachment-privacy.ts<br/>mockup-capture.ts · mockup-versions.ts · mockup-live.ts · mockup-widget.ts<br/>mockup-linked-items.ts · mockup-frame.ts · frame-host.ts · frame-ticket.ts · mockup-page-links.ts · app-proxy.ts · app-outage.ts · page-thread.ts<br/>whiteboard/<br/>yjs-protocol.ts · sse.ts · sse-mux.ts · sse-writer.ts"]
    board["Board<br/>tasks.ts · task-*.ts · review-items/<br/>home-pane.ts · board-membership.ts · activity.ts<br/>library.ts · library-location.ts<br/>review-plan · review-sizing · cross-review-queue · cross-review<br/>review-answer-ledger · board-summary · landing-review · landing-goals · landing-changes<br/>review-size-prefs · review-ranks · ask-feed<br/>home-feed · home-remotes · landing-remote<br/>lead-rank-wiring · held-window · inbox/ · coach/"]
    meet["Meetings<br/>meetings.ts · meeting-*.ts · notes-*.ts<br/>notes-edit-guard.ts · notes-invented-links.ts · notes-scheme-links.ts<br/>notes-method-*.ts · transcribe-*.ts · recall*.ts"]
    keep["Keep-moving<br/>stall-wiring · stall-gate · stall-nudge<br/>stall-escalation · waiting-unfiled-escalation<br/>waiting-unfiled-review · waiting-unfiled-sidecar<br/>waiting-unfiled-routing · waiting-unfiled-frame<br/>waiting-unfiled-filing<br/>unanswered-thread · keep-moving · owner-ask · waiting-unfiled · blockage-lift<br/>keep-moving-verdict · ui-review-gate<br/>stall-frame-news · wake-sent-sets<br/>ready-nudge · ready-gate · ready-release · board-activity"]
    ident["Identity and sharing<br/>auth/ · share/ · identities.ts<br/>sharing-notice.ts<br/>org-relay/ (its own process)<br/>github-hub.ts · github-relay/ (its own process)<br/>keeper/ (its own process: Cloudflare and Fly credentials, passkey approvals)"]
    prompts["Model prompts<br/>prompt-catalog.ts · prompt-store.ts<br/>prompt-sections.ts · routes/prompts.ts"]
    ops["Ops<br/>deploy*.ts · dependency-install.ts · client-release.ts · plugin-release.ts<br/>sentry.ts · sentry-projects.ts · attach-mounts.ts<br/>supervisor-health.ts · supervisor-restarts.ts · supervisor-reap.ts · supervisor-hang-capture.ts · server-starts.ts<br/>liveness.ts · event-loop.ts · memory-log.ts · memory-footprint.ts<br/>slow-load-alarm.ts · page-loads.ts"]
  end
  core["core — pure shared library"]
  disk[("data dir<br/>.ydoc · JSONL · JSON")]
  files[("bound files<br/>.md in the user's repos")]

  app -->|"REST · Yjs WS · SSE"| edge
  wid -->|REST| edge
  plug --> mcp
  mcp -->|"REST · SSE"| edge
  edge --> docs & board & meet & ident & ops & prompts
  board & meet & keep --> prompts
  prompts --> disk
  board --> keep
  docs <--> files
  docs & board & meet --> disk
  app & wid & mcp -.-> core
  srv -.-> core
```

| Package | What it is | Hard constraint |
| --- | --- | --- |
| `core` | Wire types, the Yjs⇄markdown document model, anchors, attachment-set ids (`attachment.ts`), review-item rules, goal arithmetic, schedule rules and their English, prompts. | Imports no other workspace package. No `node:` I/O beyond path math, no DOM. |
| `server` | The one process: data dir, the doc store, board, meetings, auth, sharing, deploys. | The only writer of durable state. Everything else asks it. |
| `workspaces-app` | The browser client, six bundles from `scripts/build.ts`. | Ships as static assets the server publishes as a numbered release. |
| `mcp` | The MCP connector agents talk to — a **client** of the server's REST and SSE. Its per-session wiring is `connector-session.ts`, which the server hosts, one per agent, working directory and default board, behind `/mcp` (`server/src/connector/`). `relay/` is the node relay: a stdio-to-`/mcp` forwarder with no tool code of its own. The full stdio child is still built, as the rollback. | No business logic the server does not also enforce. |
| `widget` | The injectable comment widget for mockups and dev servers. The board imports it into its own bundle rather than loading `/widget.esm.js`, because that bundle carries its own Yjs and a page must run one copy (`check:client-boot` counts them). `widget-iife.ts` is only the script-tag bundle's entry: it imports `widget.ts` and exports nothing. | 40 KB gzipped (`check:widget-size`). Vanilla JS, no framework deps. |
| `plugin` | Skills, hooks, a bundled copy of `mcp` (the full child and the node relay), and `relay/relay.swift`, the compiled relay's source. The launcher compiles it on first use. | Version bumped in three places; see CLAUDE.md. No compiled binary is ever committed. |

**A traced request is named by its route, and the table of routes is
checked.** Both sides send Sentry events, and neither may send a raw path: a
span or transaction name goes through `routePatternForSpan`
(`core/src/route-templates.ts`), which matches the path against every route
this server has as a whole-path template and collapses every segment it
cannot place to `:id`. The degrade is safe by construction, so the risk is not
a leak but a NAME: a route missing from the table arrives as `/:id/:id/:id`
alongside unrelated ones, and Sentry's N+1 detector reads two different calls
as one call twice. `packages/server/test/span-route-names.test.ts` walks
`ROUTE_TABLE` and fails on any fixed-length route the table cannot name, so
the list stays whole without anyone remembering to extend it. The scrub floors
either side of it — key-targeted, then id-shaped — stay in
`core/src/trace-privacy.ts`, which re-exports the function.

**Two callers wanting the same thing share one read.** The board shell mounts
`<meeting-banner>` in each pane, so the calendar read is
`workspaces-app/src/calendar-events-source.ts` rather than the element: it
hands a second caller the request already in flight and forgets it the moment
that round settles, which is a shared read and not a cache with a lifetime.
`link-titles.ts` holds the same shape for its lookup POST, keyed per URL.

**The MCP connector can run inside the server.** `server/src/connector/` hosts
the same `connector-session.ts` the stdio child builds, one per agent,
working directory and default board, behind `/mcp` (Streamable HTTP, loopback only). It is the
one place `server` imports from `packages/mcp/src`, and the direction is
deliberate: the connector is the mcp package's code, and the server only
supplies its two seams — REST over a loopback socket, so every route gate
sees what it saw from the child, and the event stream opened in-process, so
an agent the previous process was hosting is subscribed again before the
first request after a restart.

**A session's MCP child is a relay to `/mcp`.** `.mcp.json` still names
`bin/claude-workspaces-mcp.sh`. The launcher tries three children in order,
and every step down is silent and safe:

1. On macOS, a Swift relay (`plugin/relay/relay.swift`). It is compiled with
   `/usr/bin/swiftc` into a per-user cache keyed by the source's hash, and must
   pass `--self-test` before it is used. It uses about 11–15 MB idle.
2. The node relay (`mcp/src/relay/`, bundled as `plugin/mcp/relay.js`). It is
   used when the compile is impossible or failed; a failed compile is not
   retried for a day.
3. The full stdio child. It is used with `CW_MCP_RELAY=0` (the rollback
   lever), or when the session's name, board or directory is not ASCII.

Either relay does four things. It mints the agent's token at
`GET /api/agent-token`, and every `/mcp` request carries the session's
identity headers and that token. It holds a push while a tool call is in
flight. When the server is down it answers `initialize` itself, and sends
`tools/list_changed` once the server answers. Everything else — frame
handling, self-authored and bookkeeping drops, acks, watches — runs in the
hosted session. `packages/server/test/relay-stdio.test.ts` drives the
compiled relay and the node relay through the launcher against a real server.

**The voice router's model step is a seam.** `voice-classifier.ts` holds
the type `VoiceRouter` asks (`VoiceClassifier`) and the shipped one,
`jsonClassifier`, over `voice-prompt.ts`. `voice-choice.ts` asks the same
decision as one choice question over the routes plus "none", and
`voice-jev.ts` builds that question for TypeSafe's Jev with an injected
transport and no address. Production asks the choice question
(`routerClassifier`, chosen by `voiceRouterArm` in `bin.ts`) unless the owner
has rewritten the router prompt on the settings page, which only the JSON
prompt reads; test servers keep the JSON arm. Both are arms of the router
eval (`scripts/voice-router-eval.ts`). The choice question offers the quick
actions as options: `voice-quick.ts` holds those actions, which the page does
with no agent (another board, a plan or a meeting, feedback about the app,
help), their word-only detectors, and every ack of six words or fewer.
`voice-meeting-context.ts` is what a meeting's "Claude, …" is asked with
besides its words — the doc's text and the room's last two minutes — and
the fence both prompts and the lead's line put it in.

**Model prompts are a subsystem, not a scatter of literals.** Every set of
words this server sends to a model is one row of `prompt-catalog.ts`, and
`prompt-store.ts` keeps whatever the owner has rewritten in
`<dataDir>/prompts.json`. Each caller — the notes composer, the meeting
capture extractor, the voice router — takes its
instructions as a **thunk** and calls it per tick, so an edit made on
`/settings/prompts` reaches the next model call without a restart or a
deploy. The shipped default for each stays beside the code that builds the
rest of its message (`notes-prompt-store.ts`, `meeting-capture-prompt.ts`,
`voice-prompt.ts`, `core/summary-prompt.ts`), and the catalog imports them;
the store never holds a default, only an override. The notes composer's own
half of that — assembling the tick's whole prompt — came out to
`notes-prompt-build.ts` when the compose started taking a prompt cache: it
returns the prompt already split at the line the cache breakpoint is taken
on, and `meeting-notes-composer.ts` is left with the HTTP seam.
`notes-prompt-cache-shape.ts` sits beside them as an instrument rather than a
step: it holds the previous tick's block digests so the timing row can say
whether a tick that read nothing had a prefix that MOVED or one still under
the model's minimum cacheable length. It changes no prompt and no breakpoint,
which is why it is not drawn in the flow. Two of the six are
fields on a **board** rather than on the server and keep being written
through `PUT /api/workspaces/<id>/settings` — `routes/prompts.ts` says so
with `scope` rather than serving them twice, and the client hides the split.

Every default is **markdown with `###` sections** (2026-09-11), and a caller
that changes a prompt before it goes out does it by heading, never by an
exact sentence: `prompt-sections.ts` cuts, replaces and appends whole
sections, so a solo meeting drops `### Speakers and links` and a ledger
method swaps `### Grouping` however the owner has reworded their bodies.
`prompt-markdown-migration.ts` is the one-shot move of stored overrides onto
those defaults — an override that is an old default word for word is
soft-cleared, any other is kept and marked "written before markdown" — run
by `prompt-store.ts` on a version-1 `prompts.json` and by the board hydrate
on the two board fields.

**Where a route lives.** Everything that decides which URL paths it answers is
under `routes/`, `server.ts` composes and delegates to it and matches nothing
itself, and imports point one way: `server.ts` → `routes/` → everything else.
So `routes/shell-static.ts` (which page or asset an address gets) and
`routes/upgrade-stream.ts` (this request wants a connection, not a response)
sit there rather than at the top level, while `request-admission.ts`,
`request-attribution.ts` and `socket-handlers.ts` stay top-level because they
run for a request whatever path it named. `board-sockets.ts` joins them: it
opens one more listener per board, a unix socket, that records the board for
each request it accepts and hands it to the same front door, where
`middleware/board-socket-door.ts` holds the request to that board. It names
no path. `board-socket-roots.ts` sits beside it as a store: the projects
each walled lead can write, which `routes/board-socket-roots.ts` sets from
loopback. `bound-path-guard.ts` is the read and write the bound-file
reader (`slow-fs.ts`) uses under those roots, each checked by where the
open file really is. `git-hardening.ts` decides where the server runs no
git at all (a repository holding such a project) and the options every
other git read passes, so a repository's settings cannot make that read
run a program. `server-options.ts` holds
`ServerOptions` so a route can name it without importing the router back, and
`review-gate-types.ts` holds the two verdict shapes a route and the gate both
need. `review-hold-message.ts` joins those two at the top level: it is the
sentences the gate says to a filer when it holds an item or admits one
unjudged, out of `review-gate.ts` so that "a hold proposes no replacement
text" is a rule with a unit test rather than a habit of one long function.
It sees no `Request` and names no path, so it is not a route. Full rule: [.claude/rules/code-health.md](../../.claude/rules/code-health.md).
The board-roles work added `routes/workspace-members.ts` — who has access and
at what level — inside a directory this picture already draws, so the picture
does not move; what a board's Owner may do that a Regular User may not is
decided in `request-admission.ts`, beside the rest of admission.
`member-home.ts` sits beside it for the same reason: the list of boards a
signed-in member sees at `/`, and the one refusal page for a board they were
not given, are answered BY the gate from the membership it just checked, so a
board the list names always opens and one it leaves out never does. It sees a
`Request` only to ask whether it is a navigation, and names no path of its own.

**And every one of those paths is written down once.** `routes/route-table.ts`
holds the vocabulary — a gate is `trusted-local`, `loopback-only`,
`share-scope`, `owner-in-handler`, `collab-scope`, `recall-callback` or `open`
— and `routes/route-table-rows.ts` holds the rows, one per path pattern.
`Bun.serve` mounts them as its `routes` object, so the table is a value the
process holds rather than a document that rots, and
[routes.md](routes.md) is the rendered copy (`bun run routes:table`). Both
files sit under `routes/` and change none of the picture above: they name URL
paths, which is what that directory is for.

The gate column is a CHECKED claim, not a comment.
`shareScopeAllows` is a pure function of the path, the method and the share, so
`test/route-table.test.ts` drives it with each row's own example address and
fails when the guard disagrees. That is what makes a route added above its
gate a CI failure: a new address under an already-allowed prefix either
declares `share-scope`, or declares `owner-in-handler` and names where the
in-route refusal lives. It cannot be filed as `trusted-local`, because the
guard would say otherwise. What the table still cannot see is whether an
`owner-in-handler` route really carries its refusal — that one is the
reviewer's, and the routes that have it carry their own tests.

Dispatch stays with the ordered chain on purpose, and the chain is
`routes/request-chain.ts` with its two lower thirds, `request-chain-board.ts`
and `request-chain-tail.ts` (shared shapes in `request-chain-context.ts`).
`createServer` builds its context once and matches no route itself. Bun
matches by specificity; this router's order is behaviour in eight documented
places, among them the Recall status webhook immediately above the
`/recall/` upgrade and every `…/docs/:docId/meetings…` pattern above the doc
resource catch-all. So every mounted entry's handler is the same front door an
unmatched address reaches through `fetch`, and the table is the registry
rather than the router.

**How a family wires itself in.** `feature-module.ts` is the shape: a family's
`start` takes the long-lived values it reads and returns its routes, its
`stop` and any values other families read. A family whose routes claim a
prefix nothing else answers is registered in `routes/features.ts`: the chain
tries every registered family at one position (where Incoming Messages sat,
below the voice API and above the coach) and shutdown stops them at one
position, so adding one is a module plus a line in that list, with no edit to
`server.ts`. `routes/inbox-feature.ts` is the first; what a registered family
may read is `routes/feature-routes-context.ts`. A family whose construction
others read, or whose teardown has a fixed place, is started by hand from
where its block sat: `meeting-wiring.ts` (in the Meetings group) builds every
meeting relay before the doc store and is disposed after the sockets close.

**What runs on a clock.** Three loops in the server tick rather than answer a
request, and all three take an injected `now` so a test moves the clock
instead of waiting: the two board wakes in the Keep-moving group (the
stall tick also records `keep-moving-verdict.ts`, the PASS/FAIL measurement
of that group, off the same snapshot the wake reads, and reads
`ui-review-gate.ts` — the one finding in the group about a task that is
MOVING, an agent-filed UI task being built with nobody's answer on it. It
stays a pure module while judging real work: the changed-file list comes in
as an injected read, which `stall-wiring.ts` builds from the dispatch
registry's worktree path and `git-diff.ts` —
[stall-check/](stall-check/README.md); the ready-work wake's idle clock —
which of the two halves counts which events — is `board-activity.ts`, read by
both `ready-nudge.ts` in memory and the store's emit choke point on disk, and
which rows one act made dispatchable is `ready-release.ts`, the pure diff of
two readings of that same ready set — the wake for a person agreeing a goal
band or closing a blocker, neither of which is a transition on the row that
became ready), and
`task-scheduler.ts`, which files an instance each time a task's schedule comes
due ([scheduled-tasks](scheduled-tasks.md)) and, on the same pass, has
`task-run-record.ts` read each rule's last run back — recording the success,
and filing one review item when a rule has gone stale — and
`task-scheduled-wake.ts` get somebody onto the instance: an addressed frame
to an attached owner, one spawn request to the fleet's spawner for a detached
one, bounded retries, then a review item. `task-run-output.ts` runs on the
same pass: a run that wrote files into the rule's declared output folder
files ONE review item linking them, replaced by the next run. It reads the
project's files through the Library's listing, which `server.ts` hands it from
`routes/workspace-library.ts`, so the scheduler never imports a route. What the loop reads — every rule
task with its cursor resolved, including the last change of the doc or task an
on-change rule watches — is `task-scheduler-rows.ts`. All of them join the
Board group under its `task-*.ts` glob rather than changing the picture — they
read and write the same tasks through the same store, and only the clock is
new. The two
wake frames render in `mcp` through `scheduled-line.ts`, beside the other
line modules.

**A verb says what it can do, in its own answer.** Two small modules exist
because a capability announced only in a skill goes unused: a skill is read
once, at session start. `attach-mounts.ts` in `server` words what an attaching
session is told about its project's mounted folders — the count and the names,
or, when there are none, what `mount_folder` does and that `.gitignore` is not
a privacy control. It sits beside `sentry-projects.ts` in the Ops group and
for the same reason: the attach answer is where a session learns what this
deployment can do for it. `schedule-output-line.ts` in `mcp` is the same shape
one layer out — it words `set_task_schedule`'s answer about the folder a
rule's runs write into — and joins the line modules beside
`scheduled-line.ts`. Neither moves a boundary: both are pure wording, read by
one caller each. `review-item-line.ts` is the third and joins them: it words
the frame for a review item filed, revised or reinstated on a TASK. Those
events carry `taskId` and no doc, so they fell through the doc-shaped tail of
`channel-messages.ts` and reached readers naming `doc_id: "unknown"` with no
task and no ask; the line module holds the wording and the two-part test for
which items are ticket-borne, and the routing decision stays in
`emitChannelMessage`.

`task-wait.ts` joins the Board group under the same `task-*.ts` glob and
moves no boundary either. It writes one field on a task — what an agent
declared the row is waiting on when the thing is NOT on the board, with the
time the declaration lapses — and the Keep-moving group is its only reader:
`stall-gate.ts` annotates the rows it names with the declarer's words, and
`stall-nudge.ts` stops escalating a stalled row while the declaration stands.
The direction is one way, Board written and Keep-moving read, which is why the
new module sits beside the store rather than inside the group that consumes
it. Nothing about dispatch changes: a declared wait alters what the wake
SAYS, and `block_task` remains the verb for a blocker the board can verify.

**A schedule rule has one spelling.** `core` holds ten modules for it and no
other package holds any: `task-schedule.ts` (the rule type and the occurrence
arithmetic), `schedule-trigger.ts` (the kind that runs on a doc or task
change, and its quiet window), `schedule-parse.ts` (a rule read off the
wire), `schedule-output.ts` (the folder a rule writes into, and which of a
project's files are one run's output), `schedule-timezone.ts` (instant ⇄ wall clock),
`schedule-missed.ts` (what a rule wants done about an occurrence the server
missed — catch up, skip, or fold into the open catch-up that is the lock),
`schedule-run-record.ts` (what the task says about its last run, and when a
rule's last success is old enough to call it stale — one derivation the board
and the server both read), `schedule-wake.ts` (the wake's retry schedule and
what one instance's wake records, which the run record reads as answered or
not),
`schedule-phrase.ts` (a rule written as canonical English) and
`schedule-phrase-parse.ts` (English read back into a rule). The last two are a
pair and are asserted to be inverses, which is what lets the editor show one
rule as a phrase and as chips without either view being the source
([scheduled-tasks](scheduled-tasks.md)).

**A document's identity is the repo and the path, not the checkout.** Four
server modules hold that, and they sit in the doc-store group beside
`doc-origin-repo.ts` because they answer the same question one layer up.
`doc-key.ts` derives the key — the repo's origin URL (or, with no remote, its
main directory) plus the path from the repo root — reading git's plumbing
files directly rather than spawning anything. `repo-registry.ts` is the lookup
table from that key to a doc id, plus the checkouts of each repo somebody has
registered; it is a table of ALIASES, never a rename, because every component
of a key can change and a saved link must keep resolving; its file half —
the shape on disk, the atomic write, and the refusal to overwrite a registry
that did not parse — is `repo-registry-file.ts`, and its checkout rows — adding
one, retiring one softly, and listing the checkouts that exist right now — are
`repo-registry-checkouts.ts`, so the class beside them holds only the
decisions about when to write. `doc-copies.ts`
looks at all the copies one key names and says which is live, which have
drifted, and when the answer is a question rather than a value;
`doc-live-copy.ts` is the half that acts on that verdict — moving the binding,
recording drift, or refusing with a table of candidates for a person to choose
from. `routes/repos.ts` is the family that exposes the registry and that
refusal over HTTP, loopback-only for the reason the deploy route is: every
value in it is a path on this machine. Nothing here changes how a doc id is
minted — ids are still random and still minted in one place — so the picture
above is unchanged: this is a lookup in front of it.

**A project's mounted folders reuse that identity for files that are not
documents.** `mount-registry.ts` is the table — which subfolders of a repo the
lead mounted, the `f-` address each file in them answers at, whether the
project's files may leave the machine, and where its conventions index lives —
with `mount-registry-file.ts` as its shape on disk. It keeps its own
`mounts.json` beside `repos.json` rather than living inside it: the repo
registry is written on every bind, and a mount table changes for unrelated
reasons; the two are joined by `repoKey` through `RepoRegistry.repoInfo`, so a
repo that re-keys carries its mounts across. `mount-scan.ts` is the walk and
the move fingerprint — a `stat` pass over folders measured in tens of
gigabytes, so nothing is read whole and only files that vanished or appeared
are ever hashed. `mount-store.ts` is every decision that needs a filesystem:
where a relative path is joined, what a mount currently holds, and the
reconcile that turns a rename into an alias so an address and its comments
follow the file. `routes/mounts.ts` carries two gates in one family — the
lead's table is loopback-only like `routes/repos.ts`, and a file's address is
member-facing but absent from `shareScopeAllows`, narrowed further to
on-the-box callers when the project is marked local-only. Retention is the
project's throughout: unmounting is soft and nothing under a mount is ever
deleted.

**An attachment set carries the same privacy without a project.** A folder
bound with `attach_folder` needs no git checkout, so it has no project to be
marked local-only. `attachment-privacy.ts` keeps the answer per set id in its
own `attachment-privacy.json`, because a set's members are opened lazily and a
flag copied onto each one could be missed. `server.ts` asks it once per
request, right after admission and before the websocket upgrades, so no
file route has to remember to.

**A folder says what it left out, and plays what it holds.** `fs-scan.ts`
lists a set's folder with `git ls-files -z` (a name with a byte above 0x7f is
otherwise C-quoted and names no file), and `scanFolderReport` adds every file
the listing left out and why, for a bind's `skipped`; a bind's `include`
admits ignored files by name (`admitIncluded`), and its answer's `listed`
names every file it listed and `links` gives each its page link. A link to a
file nobody has opened yet opens its doc on the first request
(`openListedMember`); `files` stays the docs the bind opened, only the entry.
`folder-file-types.ts`
names the binaries no surface can show, which the listing leaves out. A video
or raster image (`core/src/media-types.ts`, read by server and page alike)
becomes a member with no binding; `routes/review-raw.ts` streams its bytes
with range requests, and `workspaces-app/src/media/` mounts the player in
place of the code view.

Three more modules put the documents that already exist onto that identity,
and none of them runs on the server's own clock. `doc-identity-plan.ts` is a
pure planner — it takes the corpus as an io parameter and says which key each
document would claim, which documents would collapse onto one, and which it
cannot place — so the dry run is the same code as the run.
`doc-identity-migration.ts` is the half that touches disk: it files the
claims, copies each losing document's conversation into the winner through
`doc-thread-merge.ts`, asserts that the thread count before equals the count
after, and commits its journal and its claims together — `doc-identity-journal.ts`
holds that record and the revert that reads it back, because the journal and
the registry are written at one point and a run that cannot write one must
file neither. `doc-identity-check.ts` reads that record back long after the
run and asks whether each merged winner still holds the threads its losers
hold — read-only, and the only mode of the script that is safe with the server
up, because a write lost AFTER a run is invisible to the run's own parity
assertion. Only `doc-thread-merge.ts`
is reachable from the running server's future; the other two are driven by
`scripts/migrate-doc-identity.ts`, by hand, because a corpus walk that spawns
git and hydrates documents is not something a restart should do.
`doc-identity-renames.ts` is the fourth, split off because it is the only part
that runs a subprocess and the only part holding state between calls: one
`git log` per repository, memoized, because a corpus of thousands of documents
cannot afford one per document.

`note-list-gap-repair.ts` and `note-list-gap-corpus.ts` join that group and
change nothing about the picture: another corpus walk nothing on the server
calls, driven by `scripts/repair-note-list-gaps.ts`. They split the way the
doc-identity pair does — the first decides and rewrites a `Y.Doc` it is
handed and never sees a filesystem, the second walks a data directory, takes
the backup and writes. It repairs the documents whose notes read
with blank lines between them — an empty paragraph a browser left at a
section end, which stopped each new note joining the list above it — by
moving the stranded items into that list and re-minting the comment anchors
at the offsets they held. The defect that made them is fixed in
`packages/core/src/prose-batch.ts`; this is only the documents already
written.

**A bound mockup is a live surface, and it keeps its rounds.** A mockup's doc
holds no content of its own — its surface is somebody's HTML file — so the
`mockup-*.ts` modules are what make that file behave like an attachment.
`mockup-widget.ts` adds the comment widget on the way out and
`mockup-live.ts` adds the script that makes the page update itself, both at
serve time, so review scaffolding never has to live in a file a build step
writes or git tracks. `file-binding.ts` watches the source through the SAME
shared mtime sweep every bound `.md` uses — a mockup binding is watch-only,
never writes back, and touches no fragment — and hands each change up as a
`mockup.updated` frame on the doc's own channels. What that sweep calls a
change is one stamp, and `file-stamp.ts` is where it is read: the mtime in
NANOSECONDS plus the byte count, so a same-length write landing in the same
millisecond as the last one is still seen. A code file or a live diff member
is flat text, and when its file changes `flat-text-patch.ts` brings the doc's
`content` to the new bytes by rewriting only the lines that differ: a
whole-text replace would leave every comment anchor and every open editor's
collapsed diff stretches pointing at deleted text. An open page fetches the
round it names and swaps its content in place, keeping the reader's scroll and
letting the widget re-anchor its threads onto the new DOM, so a comment whose
element is gone becomes an outdated one rather than a lost one. The page-side half of that script is two modules in the widget package rather
than one: `mockup-live.ts` owns the swap, and `mockup-live-scripts.ts` owns
what re-inserting the round's own `<script>` elements does — including the
redeclaration a second round used to die on, which browsers report two
different ways. It joins no subsystem; it is the swap's other half, split for
size.
`mock-page-lift.ts`, also in `mockup-live.js`, moves the mock's own fixed
buttons along the bottom up by the review-item dock's height while an item is
docked, so the dock never covers them; the widget's own buttons already rise by
that height. It joins the same subsystem and changes no route.
`mockup-page-links.ts` reads the HTML at bind time for root-relative `<a
href>` and `<form action>` links, which resolve against the workspaces host
inside a mockup, and the bind answers with a warning naming them and the
board's app address when one exists. `attach_app` runs the same detector on
the app's root page, fetched once, and warns about links outside
`/workspaces/<ws>/apps/<doc>/`: a dev server started without that base path.

`mockup-capture.ts`
still keeps the single fallback copy that lets a link outlive its scratch
directory; `mockup-versions.ts` keeps the history beside it, so the page a
reviewer was looking at when he commented is still readable at `?v=<n>` after
the next round replaces it. Same link, every round — which is what a rebind
under an existing id has meant since it started destroying the page underneath
the comments.

**A served mock runs in a sandboxed frame, and speaks to the board through
the page around it.** A mock's scripts are somebody else's code, so the mock
is never served on the board's origin beside the reader's session.
`mockup-frame.ts` (server, beside the other `mockup-*.ts` modules) makes
`/workspaces/<ws>/mockups/<id>` answer a small host page. That page holds one
frame of the same address plus `?cw-frame=1`, whose response is sandboxed by
CSP. The frame fetches nothing from the board by itself, because an
opaque-origin frame's requests carry no Lax cookie and Access would redirect
them: the server writes the bridge, the widget, `mockup-live.js` and any
board script or stylesheet the mock names (`/widget/…`, `/app/…`) into the
frame's bytes, and voice feedback's script and each round's page come through
the host. Three new top-level modules in the widget package are
the two ends of that line, and each is a separately built asset rather than
part of `widget.iife.js`. `mock-bridge.ts` runs first in the frame and hands
the widget's board-bound fetch, WebSocket and EventSource calls to the host.
`mock-host.ts` is the host page's script: it builds the frame, and it makes a
call only when `mock-relay-policy.ts` (pure, tested alone) says it is this
mock's own. It stamps every call it makes with `x-cw-via: mock-frame`, or
`cw-via=mock-frame` on a socket. The stamp travels as `via` on the
comment or answer it writes, and agents read it as "sent from inside the mock
page". Nothing else changes in the data flow: the calls are the same routes
and sockets, made from a different page. The rule and its limits are in
[security.md](security.md).

**The frame can live on its project's own frame hostname.** `frame-host.ts`
(server, top level, beside `mockup-frame.ts`) is off unless `CW_FRAME_ORIGIN`
names the project's frame hostname, `<project>.<frame domain>`, on a domain
that is not the board's. Set, a host page on one of the board hostnames
(`CW_FRAME_BOARD_HOSTS`, default the operator's proxied hostnames) points its
frame at the same path on that hostname, and the frame gets a real origin on
another site: storage of its own, and no way to read or set the board's
cookies. The host page writes a frame ticket into the frame's address
(`frame-ticket.ts`), which the frame hostname trades for a partitioned cookie,
because Safari sends a frame on another site no Access cookie. The ticket and
the cookie are two signed formats, so a cookie cannot be redeemed for another
one, and the cookie ends twelve hours after its ticket was minted. A share or
collaboration visitor's page keeps the opaque frame. Request admission checks
the frame hostname before any other kind, and answers there only a mock's
frame, an app door's paths and the widget's public scripts, each only as the
fetch type it is loaded as, and an app's files only to a page on the same
frame hostname; everything else is a 404 before a route runs. The board
router sends `<project>.<frame domain>` to that project's server. The
bridge learns the host page's origin from the frame's seed and relays every
call by path, so the host still resolves it against the board's hostname.

**A whiteboard is a doc whose content is a drawing.** Its type is
`whiteboard`, and its `.ydoc` holds one Y.Map of Excalidraw elements keyed by
element id, with no bound file. Every write replaces a whole element, and the
copy with the higher `version` wins, then the lower `versionNonce`
(`incomingWins` in core's `whiteboard-scene.ts`). That is Excalidraw's own
reconcile rule, so the server, every page and every agent converge on the same
scene. A delete is a newer copy with `isDeleted` set, never a removed key.
`/workspaces/<ws>/whiteboards/<id>` serves `whiteboard/page-shell.ts`, and the
page is its own bundle, `whiteboard.js`. It is the one place the app runs real
React, because Excalidraw needs it; React and Excalidraw load behind one
`import()` so the header and socket come up first. The page writes to the
scene only when no gesture is in progress, so a half-drawn stroke never
reaches anyone, and it holds back a remote copy of an element the person is
still drawing or dragging until they let go (`whiteboard/scene-sync.ts` in the
app). Agents draw through `POST …/docs/<id>/whiteboard`
(`routes/whiteboard-routes.ts`), which turns boxes, ellipses, arrows and text
into elements (`whiteboard/elements.ts` on the server) and can set the one
spot the agent points at. That pointer lives in the server's awareness state
under `agentPointers`, keyed by agent, because the server holds one awareness
state per doc. A burst of strokes from one actor becomes one
`whiteboard.changed` frame once that actor has been still for
`whiteboardSettleMs` (`whiteboard/scene-events.ts`), and the MCP child drops a
frame its own agent caused (`self-authored.ts`). Comments on a whiteboard are
not wired yet.

**An attached dev server is served like a mock, from the board's own
address.** An agent runs a site's dev server on a loopback port and binds it
with the `attach_app` MCP verb, which posts to `/workspaces/<ws>/apps`. That
makes a doc of type `app` whose `sourceUrl` is the origin, filed on the board.
`routes/apps.ts` then answers `/workspaces/<ws>/apps/<id>/<path>` by fetching
`<origin>/<path>`. A document gets the mock's host page and sandboxed frame,
with the widget and bridge written into the frame. Everything else is relayed
as a stream, so the dev server's reload event stream reaches the page, and the
bridge relays the page's own fetches and event streams under the app's prefix
(`mock-relay-policy.ts`). `app-proxy.ts` is the pure half: the loopback rule,
the path check and which headers cross. Nothing inside the page is rewritten,
so the site builds its links under the prefix. The page's query reaches the dev
server byte for byte minus the frame flag, and the host page hands its
fragment to the frame. What this does not carry
behind a sign-in is in [security.md](security.md).

**A dev server that stops answering is news for whoever can start it.** When
the proxy's fetch throws, the reader gets a waiting page as a 503, not a 502:
Cloudflare replaces an origin 502 with its own "Bad gateway" page, which is
what the owner read on 24 September while this server was up. The page
(`app-waiting-page.ts`, an HTML renderer beside `shells.ts`) names who was
asked and when, polls its own address with HEAD, and opens the app when that
stops answering with the `x-cw-app-down` mark. After two minutes it offers
"Ask again", a `POST` to the bare `apps/<id>` address that sends a second
notice marked `askedAgain`, at most once per two minutes.
`app-outage.ts` (beside `app-proxy.ts` in the doc-store group) turns the first
failure into one addressed `workspace.app_unreachable` frame on the board
stream and one `[apps]` log line, and stays quiet until a request the app
answers re-arms it. The frame goes to the agent the attach recorded as
`producedBy.agentId`, else the board's lead; `app-unreachable-line.ts` in
`mcp` words it, beside the other line modules.

**An agent comments on a page it cannot see.** `create_thread` on an app or a
mock takes `find` as the words the page shows, and an app also takes `path`,
the page inside it. `page-thread.ts` (beside `app-proxy.ts`) turns those into
an element anchor whose fingerprint is the words alone, with the address the
widget in the frame reads as its context, and refuses what it cannot honour
before anything is written. Such a fingerprint resolves to the smallest
element that says the words (`resolveWords` in core's `anchor/element.ts`),
which the budgeted bundle reaches only through `window.cwWords`: the lazy
edit chunk installs it when the doc holds a words anchor, then redraws the
pins. An optional `suggest` stores new words on the first comment; the same
chunk (`edit/edit-suggest.ts`) shows them in the popover with Accept, which
files a pencil-style `pageEdits` thread and resolves the suggestion, and
Reject, which only resolves it. The same chunk redraws an edit's comment in the widget
as its word diff (`edit/edit-diff-view.ts`), since the budgeted bundle shows
every comment as plain text.

Every link to such a thread is the page plus `?thread=<id>`, built by
`page-thread-link.ts`, a top-level module of core so the server and the
board client share it: the agent's `threadUrl`, a review item's push
(`review-gate.ts`), the Home opener (`board-queue-open.ts`) and the
cross-board review (`cross-walk-model.ts`), the last two through
`board/doc-thread-href.ts`. An app's Home-queue row carries `pageUrl`, its
thread's anchor context, because the client has no anchors to read it from.
A page outside the doc falls back to the doc itself.

**A review item raised on a mockup is answerable on the mockup.** The ask used
to live only on the ticket, so a reader opened the mock, looked at it, and
then left for the Home queue to say what they thought. `widget-dock.ts` — a
new top-level module of the widget package, beside `widget-picker.ts` and
`widget-threads.ts` — draws the standing ask as a bar across the bottom of the
page it was raised on, opens it with every earlier ROUND still readable, and
answers it through the route the doc page already answers through
(`…/threads/:id/answer`). It joins no new data flow: a review item IS a
payload on a comment, so the dock reads the same synced threads the pins read
and adds no fetch of its own. The Home-queue entry for such an item deep-links
to `/workspaces/<ws>/mockups/<doc>?thread=<id>`, which is why a queue entry now
carries the doc's `type`.

An ask filed on a TICKET is docked on the mock it links, too. Those items live
in `task.reviews`, not in the mock's threads, so the server resolves them
instead: `mockup-linked-items.ts` (server, beside the other `mockup-*.ts`
modules) takes the Home queue's own ticket rows (`taskReviewItems`), keeps the
ones whose detail links this mock — or, for an ask that names no page, whose
task links it — and writes them into the served page as a JSON data block. The
widget reads that block once at load and answers such an item through the
ticket's own route (`…/tasks/:id/review-items/:rid/answer`). Still no new fetch
and no poll, and a share visitor is served no block: the dock shows a visitor
only the mock's own thread asks.

**The doc page draws the same dock.** A bound doc that a ticket's open ask
links shows that ask in the same bar, answered through the same ticket route.
So the dock's rules, markup, sheet wiring and stylesheet moved to `core`:
`review-dock.ts` (third tier, beside `review-item*.ts` — which asks dock, the
bar and sheet as strings, and a wiring function over the element its caller
made, so core still touches no `document`) and `review-dock-styles.ts` (the
one CSS literal, which the widget build's minifier matches by name). The
widget keeps `widget-dock.ts` for its own half. The doc page's half is
`workspaces-app/src/doc/linked-dock.ts`, mounted by `doc-floats.ts` off the
same doc-record read, in a shadow root so the sheet applies unchanged. The
items ride the doc record the page already reads — `linkedItems` on
`GET …/docs/<id>?format=json`, from `mockup-linked-items.ts`'s
`boardLinkedItems`, left out for a share visitor and when empty — so this too
adds no fetch. The bar's measured height is `--doc-dock-h`, which `doc.css`
takes out of `#shell` and adds to the composer, toast and phone comment sheet.

**A thread's ask is answerable in that thread's popover.** When an agent
answers a reader's comment with a review item, the popover the reader opens
shows the item: its latest round, the detail with its links, a button per
option or a question's answer box, and how it was answered once it was.
`widget-ask.ts` is a top-level widget module, but it ships in `mic.js` and
`mockup-live.js`, not in the budgeted bundle. Its source of truth is core's
`threadAsk`, which `dockItems` now also calls, and it reuses core's
`wireAnswer`, so the two places that answer an item cannot disagree. It reads
the raw thread map, as `edit/edit-suggest.ts` does, so the chunk carries no
Yjs. The budgeted bundle's only addition is a `data-thread-id` on each panel
row, which the module uses to mark rows that have an open ask. No new route:
the answer goes to `…/threads/:id/answer`, which a mock frame's relay already
allows for this doc alone.

**The widget's panel lists the threads on the page the reader is on.**
`widget-page-list.ts` draws the list, this page's threads newest first, then
the ones with no spot left, then other pages. A tap on a row takes the reader
to the thread's page state and shows its spot. Like `widget-ask.ts`, it ships
in `mic.js` and `mockup-live.js`, and the board mounts it beside its mic. The
budgeted bundle no longer draws a list. Each render hands the threads it read
to the element's `listHook`. A pin now matches on the path
(`samePage` in `core/anchor/context.ts`), and a thread made with other query
controls set gets a dimmed pin. Tapping it loads that address through
`widget-goto.ts`, which leaves the thread's id in session storage for the next
render to show. `widget-thread-text.ts` holds the snippet and receipt markup
that the popover and the list share. No new route and no new fetch.

**A comment's markdown is drawn rendered in its popover.**
`widget-comment-markdown.ts` rewrites each popover comment the budgeted bundle
drew as escaped words: links (`http:`, `https:` and `mailto:` only), bold,
italics, inline code, lists and fenced code, built as DOM nodes so no comment
text is parsed as markup. Like `widget-ask.ts`, it ships in `mic.js` and
`mockup-live.js`; the budgeted bundle is unchanged. It leaves a page-edit
comment alone, because `edit/edit-diff-view.ts` finds those by their exact
words.

**A pin follows an element whose words change a little each round.** The
resolver in core's `anchor/element.ts` takes the element of the anchor's tag
that says most of its words, over half of them, and none when two are equally
close. Over three rounds of a rewritten mock that is not enough, so the page
reports what each pinned element says now: `widget-anchor-refresh.ts`, called
from the page list's `listHook` in `mic.js` and `mockup-live.js`, posts the
element's fresh description to the thread's existing `…/reanchor` route with
`refresh: true`. It reports only an element that says over half of the
anchor's words with no other element of its tag as close, on the page state
the thread was made in, and not while a mock shows an older round. The server
(`core/anchor/refresh.ts`) moves only the fingerprint and snippet, keeps the
thread's context and tap spot, and stores the anchor as first made under
`firstAnchor`, once. The write lands in the doc's Yjs map, so every open page
redraws from it. A share visitor's report is refused unless the visitor is
the board's owner.

**A comment that never reached the server says so, on the comment.** Every
composer on every surface already handed the words back when a post was
refused; none of them left anything standing to say why, so a box holding your
sentence looked exactly like one you had never sent from.
`workspaces-app/src/not-sent.ts` is the one affordance all of them now draw —
a button reading "Not sent — tap to retry", beside the draft, clearing on a
retry, on a send that lands, or on the next keystroke. It joins no data flow
and reads no state: the four call sites (the board's `ComposerForm`, the doc
card's reply and its folded answer field, the doc's new-comment composer) hand
it the box, the control to sit beside, and the same send to run again. The
widget says it in its own `composerNote`, for the bundle's sake. The server
half is `server/src/comment-log.ts`, one stamped `[comment]` line per write
through `docStore.postComment` — the choke point all three write paths share —
carrying the doc, the thread, the author and the LENGTH of the text, never the
text. Between them, the next lost comment can be told from one nobody sent.

**Enter sends in every comment box.** `core/src/send-key.ts` (a new top-level
core module) is the one keydown rule: Enter or Cmd/Ctrl+Enter sends,
Shift+Enter is a line, and an IME's Enter never sends. The board's
`ComposerForm`, the walkthrough's answer box, the doc card's reply and answer
field, the doc's new-comment composer and thread view, and the widget's two
boxes all call it, and each hands it the same send its button runs, so an
empty box refuses Enter the way it refuses the button. It takes structural
types, not DOM ones, so it touches no `document`.

**And a comment that DID reach somebody says that too, on the comment.** The
other half of the same question: one grey tick means the server has it, two
mean a session watching the doc was handed it, and both disappear once a reply
lands. The decision is `core/src/comment-receipt.ts` — pure, DOM-free, so the
board, the review editor and (one day) the widget cannot come to disagree
about what a tick means — and the durable fact is a write-once `deliveredAt`
on the comment itself, stamped through `core/src/comment-delivery.ts` so it
syncs, survives a reload and rides the REST threads payload the board already
reads. The judgement is `server/src/comment-receipt.ts`, dependency-injected
over `SseBus.agentsOn` because delivery means a LIVE stream, never a line in
`agent-watches.json`; `stall-wiring.ts` calls it where it already knows a
comment's board channels, and `recordDelivery` writes the stamp once and
broadcasts a transient `comment.delivered` to pages on every channel the
comment travelled. Its other caller is the heartbeat route's hand-over of a
PARKED comment (`routes/workspace-attachments.ts`), which is where most second
ticks are set: a comment written while nobody was listening reaches a session
when that session attaches, and no doc event fires for it. On the client every app surface now draws its comment header
through `workspaces-app/src/comment-view.ts`, one module owning the structure
and the mark's position with a class-name variant per stylesheet — because a
feature added to "comments" that reaches one surface out of four is the
failure that module exists to make impossible.

**The comment card stands where its comment will live.** In comment mode the
composer is a card fixed to the right edge of the viewport at its element's
height, joined to the element by a faint line, and on post it becomes the saved
card with a tick; at phone width it is a compact panel along the bottom.
`widget-card.ts`, a top-level module of the widget package beside
`widget-picker.ts`, decides where the card goes — beside the element, or below
or above it when the element reaches into the margin, never over it — and is
asked again every frame from the widget's existing rAF loop. It joins no data
flow: it reads layout and writes only the widget's own shadow DOM.
`widget-page-bar.ts`, beside it, finds the page's own fixed or sticky bar
along the bottom of the screen and adds its height to the offset every bottom
control rides, so the FAB, the phone prompt and the dock stand on a mock's tab
bar instead of covering it. Also layout only, and re-measured on resize,
scroll and DOM change rather than per frame.

**The widget's mic, and voice feedback behind it.** The board's own widget
is bound to the Workspaces feedback doc, not to the board's project, so its
buttons are about the app; a served mock's are about the mock. On both, the
thread list shrinks to a chip and a microphone takes its slot.
`widget-mic.ts` is a top-level module of the widget package beside
`widget-card.ts`, but it is a SECOND ENTRY (`@claude-workspaces/widget/mic`)
that `widget.ts` never imports — it makes only the button, the readout and
their rules. Voice feedback itself is the widget's `voice/` directory, a third
entry (`@claude-workspaces/widget/voice`): `voice-session.ts` streams PCM over
`WS /workspaces/<ws>/docs/<docId>/voice` and writes the comments the server
settles through the ordinary thread routes (`voice-note-writes.ts`), and
reopens a socket that dropped mid-recording on a backoff while the microphone
keeps listening (`voice-redial.ts`), `voice-ui.ts` draws the live
comment and the settled cards (its styles in `voice-css.ts`, the column
layout in `voice-column.ts`), and `voice-mode.ts` glues them to the page (a
tap sends the next words to an element, or back into that element's earlier
note). Three kinds of page reach it, and none of them puts any of it in the
budgeted bundle. The board imports it directly
(`board/board-feedback-mic.ts`). A mock page gets the mic from
`mockup-live.js`. **An ordinary embed — a tag and a script on somebody else's
dev server — fetches it**: `widget-mic-inject.ts` is the few bytes in
`widget.iife.js` that append `<script src="<serverUrl>/widget/mic.js">` at
DOMContentLoaded, and `mic-entry.ts` is that chunk's entry, mounting the
button through the same `voice/voice-loader.ts` a mock goes through. Both are
top-level modules of the widget package; only the first is on the budget, and
it is reached from `widget-iife.ts` alone, so `widget.esm.js` and the board
pay nothing and the board's own mount is not doubled. `window.cwMic`, set at
module scope by `voice-loader.ts`, is how a page carrying `mockup-live.js`
tells the injector to stand down before either mount runs. Either way the
first tap fetches the lazy chunk `voice.js` (`voice/voice-loader.ts`), so a
page that never speaks pays for the button and nothing behind it. On the
tailnet name all of it goes through the widget door
(`middleware/widget-door.ts`), which admits the mic and the chunk without a
token and the socket, the thread verbs `edit-comment` and `reanchor`, and the
recordings with one. Inside a served mock's frame the browser
refuses the microphone to an opaque origin, so there the host page holds it
instead: `mock-host-mic.ts` (widget, a top-level module the host asset
bundles) opens the capture when the frame asks over its voice socket, streams
the audio into that socket itself, and never sends it into the frame;
`hostCapture` in `voice/voice-audio.ts` is the frame's side of the request. The DSP the meeting capture
already used moved to core's `pcm-audio.ts` so both captures share one
resampler and one worklet; `meeting-audio.ts` re-exports it.

On the server, `routes/upgrade-stream.ts` hands that socket to
`voice-feedback-relay.ts`, which runs the meeting's transcription engine and a
Haiku tidy (`voice-feedback-tidy.ts`) that decides which words become which
comment on which catalog element. The tidy runs at a pause in the talk, with a
ceiling for talk that never pauses; `voice-feedback-turns.ts` tracks which
heard words a note holds yet, and `voice-feedback-session.ts` holds the
relay's per-recording state types. `voice-feedback-store.ts` keeps each
recording's WAV and a timestamped raw transcript beside the doc
(`routes/doc-voice-feedback.ts` serves both). A comment's ▶ asks
`clipAudio` (`widget/src/widget-auth.ts`) for the audio: with no token held
that is the `<audio>` fetching the clip itself, with its byte ranges and its
`#t=` seek; with one it is a fetch carrying the Bearer header an `<audio>`
cannot set, played from a blob, which costs the whole recording rather than
the stretch the clip names. While the page is open, a spoken comment is the
thread POST the typed composer already makes, carrying a `voice` note (clip
and raw words). When the page goes without a Stop — a link followed, the
browser quit — the relay finishes the last note from the words it heard and
`voice-feedback-keep.ts` writes what the page could not, straight to the doc
store: it finds each note's thread by the id the page reported or by where
its clip starts, edits it, and creates only a note no thread holds. The
socket carries the upgrade's proven identity for that write; with none, the
speaker the page named at `start`.

A note whose element or meaning the tidy cannot settle gets one question.
`voice-feedback-ask.ts` decides whether the tidy's proposed question is
worth asking (never on a pinned note, never twice, two or three distinct
choices) and matches a short spoken answer without a model call;
`voice-feedback-question.ts` sends the question, says it in the spoken
reply's voice, and turns the answer into an edit of the same note, so the
page re-anchors or rewrites the thread it already made rather than adding
one.

**The board mic's spoken reply.** Holding the board mic can get a spoken
answer rather than a line of text: Claude writes a short overview into a
panel above the mic and says its first two sentences, or asks one question
and waits. The words come from the board mic's own router (`voice.ts`), so
fast paths and the hand-off to the lead behave exactly as on the plain mic;
what varies is who hears and who speaks, and four setups sit behind one
switch so they can be compared on the same board — Soniox alone, Soniox with
ElevenLabs Flash, Gemini Live, and ElevenLabs Agents, which also takes the
turns. The wire is `core/spoken-reply.ts`
(a new top-level core module: the messages and their parsers both ends read).
On the page, `board/spoken-reply-client.ts` owns the socket and the turn,
`spoken-reply-panel.ts` the panel's markup and states, `spoken-reply-audio.ts`
the capture and the player, and `spoken-reply-tap.ts` the taps; all four sit
inside `board/`, and `board-voice.ts` mounts them in place of the plain
capture only when `GET /workspaces/<ws>/voice/timings` names a setup. On the
server, `routes/upgrade-stream.ts` hands `WS /workspaces/<ws>/voice/converse`
to `spoken-reply/` (a new top-level server directory): `relay.ts` keeps one
`session.ts` per socket, `answer.ts` cuts the router's answer into a spoken and
a written part and adds the one question the router lacks ("which goal?"),
`lead-answer.ts` holds each socket's requests to the lead until the lead
answers through `POST /workspaces/<ws>/voice-queue/<id>/answer` (MCP
`answer_voice`) and says that answer on the socket that asked,
`tts.ts` and `gemini-live.ts` are the vendor adapters, `keys.ts` reads their
keys from the Keychain at runtime, and `timings.ts` logs each answer's delay
from the end of the question to the first spoken word per setup. Setup 4 runs
the other way round: `elevenlabs-agent.ts` holds the ElevenLabs conversation,
`agent-turns.ts` drives it for one socket, and ElevenLabs calls back for each
reply on `POST /voice-agent/v1/chat/completions` (`routes/voice-agent-llm.ts`,
checked by `agent-llm.ts`), on the vendor callback hostname. The billed
engines are built only in `server-deps.ts`; a test server gets none, so every
setup reads as not set up and the plain mic stays.

Each spoken sentence is a point, and a point worth keeping carries a note:
its written wording, chosen in `spoken-reply/notes.ts` (what is waiting on
the listener, or a change the board just made). `spoken-reply/speak-points.ts`
says the points one voice call at a time and sends each note just before its
point's first audio; Gemini Live speaks one stream, so there every note goes
before the tool result that starts the voice. On the page,
`board/spoken-reply-notes.ts` shows each note as its point starts to play, in
a row the reply laid out for it, and `board/spoken-reply-turn.ts` builds the
turn's `timing` report, which now carries each note's lead.

"Go through my reviews" starts the review queue by voice.
`spoken-reply/review-walk.ts` reads each item's headline and options, answers
questions about it, and reads a decision back before anything is recorded.
The read-back, the yes and the one-utterance undo window are
`spoken-reply/confirm.ts`, kept apart so a doc follow-up can reuse it;
`review-words.ts` holds the words it listens for, and `review-speakable.ts`
the rule for which items stay on the queue for the screen. The server never
writes the answer itself: the reply carries a `decide`, and
`board/spoken-review-decide.ts` posts it to the route the answer card and its
Undo already use. The request is built in `core/spoken-review.ts` (a new
top-level core module), so the card and the voice queue share one builder. A
ticket's review item gained the undo it lacked:
`routes/task-review-answer-undo.ts` over `review-items/undo-answer.ts`.

**Talking to one agent by name.** A `start` that names an agent id sends
every turn to that agent instead of the router: `spoken-reply/agent-conversation.ts`
checks the id against the socket's board, writes a row on that agent's
addressed comment queue (so an absent agent hears it at its next attach) and
sends the frame on that agent's streams alone, and `lead-answer.ts` says only
that agent's `answer_voice` aloud. Each turn carries the conversation so far
until the page names another agent. The page for it is `/voice?agent=<id>`
(`routes/voice-page.ts`, the owner's alone): `voice-agent-list.ts` (a new
top-level server module) lists the agents on every live board, and
`workspaces-app/src/voice-page/` mounts the board's spoken reply aimed at the
chosen one. Every other client talks through `voice-api/` (a new top-level
server directory, routed by `routes/voice-api.ts`): the OpenAI chat format,
one model per agent, a voice token of its own, and the same addressed row
and `answer_voice` wait underneath. Its contract is
[voice-conversation-api](voice-conversation-api.md).

**A mock or app that talks.** A page served in a board's frame can speak,
listen and post to its own dev server through
`WS /workspaces/<ws>/docs/<docId>/app-voice`. Its wire is `core/app-voice.ts`
(a new top-level core module). The client is `widget/src/app-voice/` (a new
top-level widget directory), built as its own `/widget/app-voice.js` and kept
out of `widget.iife.js`. The server half is `app-voice/` (a new top-level
server directory). `token.ts` signs a token naming the doc and the board,
`seed.ts` writes it into the frame for the owner when the frame's HTML names
the client, and `gate.ts` decides who is handed one and who may open the
socket. `session.ts` runs one socket on the spoken reply's engines, and
`say.ts` makes the write to the app. `routes/upgrade-stream.ts` checks the
token. `relay.ts` is called from `socket-handlers.ts`, the same way as the
other socket kinds. Inside the opaque frame, the socket goes through the host
page's relay, like the widget's own sockets. The design is
[app-voice](app-voice.md).

**The planning voice** rides the same socket, and is always on in a doc:
nobody says "interview me" any more (it still works). The doc's Talk button
(`doc/doc-interview.ts`, its markup in `doc-interview-view.ts`; mounted with
the voice mic by `doc/doc-voice-mount.ts`) opens the spoken-reply socket with
`{ surface: 'doc', docId }` as each turn's context. On a doc on the socket's
board the session ends each turn only at a confirmed pause
(`spoken-reply/pause-gate.ts`: the listener's endpoint, then a quiet window
that is longer after a turn ending mid-sentence), and every turn is
`spoken-reply/interview.ts`'s: the first pause begins the run (in a
meeting, the first pause after its first minute, `MeetingWarmup`). It reads the
plan's gaps off the doc's outline (`interview-gaps.ts`: empty, placeholder,
open-question and short sections, ranked by heading), holds them as slots in
`interview-state.ts` (each asked once, then placed, skipped, deferred, gone or
ended; a silence after a question offers once to skip it), and after each
answer does one of four things: writes it under its heading with
`applyBlockEdits` (`interview-docs.ts`, so threads keep their anchors), asks
once for more after a bare "maybe", answers talk about the question (a
question back, a disagreement) with one sentence and keeps the same question
open (`interview-discuss.ts`, decided by the same judge call that picks the
answer), or says nothing after "I don't know yet" and asks its next question
at the next pause. While it asks, its cursor is on
the words it means: the server sets an `agentFocus` field on its own
awareness state for the doc, and `doc/agent-focus.ts` on every open page
scrolls there and highlights them in the agent's colour. "skip", "come back
to that" and "that's enough" are `interview-phrases.ts`. `interview-log.ts`
records each section's question-to-answer time and each answer's
`after-answer` outcome as log lines and rows in
`<dataDir>/interview-timings.jsonl`, with no doc text. The doc must be on the
socket's board, checked as the router checks it. Every reply it speaks is one
sentence of at most 20 words (`oneSentence`, `interview-phrases.ts`); the
rest of what it has to say is written on the page.

A learning-goals doc, one with a "What I want to do better" heading, gets a
looser interview instead (`interview-goals.ts`). It asks at most the coach's
name and "what do you want to do better?", each once, and then follows the
speaker: one model call per spoken pause (`interview-goals-place.ts`, with a
rule when there is no model) names every change, so several goals said at
once each become a bullet in the goals section, and "change the first one
to …" replaces that goal's block. A goal the owner typed becomes a proposal
instead, so the owner's words are never deleted. The four-part `###` sections of
older goals docs are never asked.

The same answerer speaks in a bot meeting. `meeting-claude.ts` (a top-level
server module) reads each final turn `recall-meeting.ts` records and acts only
when it opens with "Claude," and the speaker's Recall participant email is the
owner's (`CW_OWNER_EMAIL`); a display name never counts. It writes a minute
into the meeting's notes only when the answer holds one (`minuteFor`), and
says the first sentence into the call
through Recall's `output_audio`, as MP3 from `tts.ts`. It is on unless
`CW_MEETING_CLAUDE=0`, and a bot that may speak is created with audio output
switched on. `scripts/recall-say.ts` (`bun run meeting:say`) is the
live check that Recall plays audio at all.

**Editing the words on a page.** The reader can change a page's text in
place, and the agent is told what changed; the widget never writes the page's
source. The pencil is `edit/edit-button.ts`, mounted by `mic-entry.ts` and
`mockup-live.ts` right after the mic, so like the mic it costs the budgeted
bundle nothing. Its first tap fetches the lazy chunk `edit.js`
(`edit/edit-entry.ts`), as does a page whose doc already holds an edit that
has not been applied, so its marks paint on load. `edit/edit-mode.ts` makes
the tapped element editable — Enter splits a paragraph, Cmd-B, Cmd-I and
Cmd-K add the three marks an edit carries (`edit/edit-keys.ts`), and
`edit/edit-markdown.ts` reads the element as markdown — keeps the reader's unsent edits
(`edit/edit-model.ts`), and draws every mark in a fixed layer of its own
rather than restyling the page. Send is the ordinary thread POST with a
`pageEdits` list on the first comment: each entry is the element's anchor, a
short CSS selector, the words before, and the words after as a small
markdown. `core/src/page-edits.ts` reads and caps that list;
`core/src/page-edits-text.ts` holds that markdown's reader and writes the
comment's text from the list — one line saying what was edited, then each
change as a word diff, with selectors left to the list — and
`routes/doc-threads-routes.ts` refuses a malformed one outright. It rides
`thread.created`, so there is no new event: the MCP channel line
(`mcp/src/channel-messages.ts`) carries the list as `page_edits` and tells the
agent to apply each edit to the source and resolve the thread. An edit counts
as applied once its thread is resolved, or once the element's words match the
edit's after-text without the reader having typed them in this visit. On the
tailnet name the door admits `edit.js` without a token, as it does the other
scripts.

**Unsent words across a reload.** A comment half-typed and edits not yet sent
come back when the page reloads under the reader. `draft-store.ts`, a
top-level module of the widget package, keys both in `sessionStorage` by doc
and page; the composer (`widget-picker.ts`, in the budgeted bundle) writes on
every keystroke, `widget-restore.ts` reopens it at load, and `edit/edit-mode.ts` does the same
for edits, the pencil loading `edit.js` when a draft waits. Inside a mock's or
an app's sandboxed frame there is no browser storage, so `mock-bridge.ts`
sends draft keys to the host page, which files them under its own doc in its
`sessionStorage` (`mock-host.ts`) and hands them back when the frame asks on
load. No server route and no event: the drafts never leave the browser.

**Which channel carries what.** *Yjs*, one WebSocket per document, carries what
two people watch change under each other's cursors: text, threads, replies,
suggestions, anchors, presence, live notes. Agents hold no replica, so an agent
edit is a REST call the server applies to the doc. *REST* carries what needs the
server as an authority — sign-in, binds, diffs, shares, deploys, and the board,
where a write is a decision with an author and a gate rather than a merged
value. *SSE* pushes changes to anyone holding no Yjs socket for them: one stream per
document at `/events/<docId>`, and one per board at
`/workspaces/<id>/events:stream`, which carries every thread event on any
member doc of that board or diff review — what an agent's `watch_doc` holds
instead of a stream per file (`routes/upgrade-stream.ts`, and
`board/board-live-wiring.ts` in `workspaces-app`). Both the colon and the
`/workspaces` prefix are deliberate, and the board stream moved to this
address on 2026-09-05 to get them: a bare `events` segment under a board path
is the activity feed's name, and a workspace id sitting outside `/workspaces`
could not be read by the guard that reads every other board path. The address
it moved off is recorded once, in [glossary.md](glossary.md).

**An agent reads a non-owner comment as quoted data.** Anyone a board is
shared with can comment, and the lead reads every comment and can act on it.
The server stamps each thread frame's comment, and the comment a reply
answers, `owner` only when the author's identity id is the owner's — never by
display name, which a visitor types (`commentTrustOf` in
`packages/server/src/actor-identity.ts`). The MCP child quotes every other
comment, and an unstamped one, inside a labelled `untrusted-comment` block
whose markers a comment cannot forge (`packages/mcp/src/untrusted-quote.ts`).

**An agent gets no wake for an event it cannot act on.** Three rules give that,
and none of them hides state.

*Its own action.* The MCP child drops a frame whose actor is this session, so
an agent's own comment, review item or task move costs it no turn. Every other
reader still gets the frame, and one whose actor the child cannot identify is
always delivered, because an agent cannot detect silence. Rules in
`packages/mcp/src/self-authored.ts`.

*An analytics event.* `review_item.viewed` records that a person opened a card
and changes nothing, so the server keeps it off the fan-out while the audit log
still gets the row. `review_item.answered` is kept off too: a ticket answer
reaches its filer and the lead as `decision.answered`, which carries the
words, the task's title and the item's id, so one answer is one wake. The
list is in
`packages/server/src/review-items/analytics.ts`.

*An act with no words.* A resolve is a status flip and carries no text, so the
MCP child drops the frame before it becomes a wake. It drops it for every
reader, not only the session that resolved the thread, which is what separates
this rule from the self-echo one. A resolve retires each review item on its
thread, so a resolve that closed an unanswered ask still wakes: it is the only
report that reaches the agent who asked. Rule in
`packages/mcp/src/bookkeeping-events.ts`.

*A second frame for one act.* A question asked on a review item's thread
arrives as the thread's `thread.created`, with the words, and as
`decision.info_requested`. The board page reads the second, so the server
sends it, and the child drops it when it carries a `threadId`. A typed "tell
me more" has no thread, so its `decision.info_requested` still wakes. Rule in
`packages/mcp/src/bookkeeping-events.ts`; `packages/server/test/one-wake-per-answer.test.ts`
counts the wakes for an answer and for a comment.

*An act with one reader.* A review item WITHDRAWN on a ticket does carry a
request, but only for the agent that RAISED the ask: its question went away.
Nobody else on the board has anything to do, and everybody else is the common
case — any agent may retire a stale ask, and the server's own auto-withdrawals
fire as a board actor that the self-echo rule suppresses for no one. So the
store stamps the filer's id on that event and the child delivers to that
session alone
(`readsThisReviewItemEvent` in `packages/mcp/src/review-item-line.ts`). A
filing and a revision are not addressed this way: those are news to the board.
The id is stripped from a visitor's copy with every other id
(`packages/server/src/share/redact-board-events.ts`).

Which rule runs where depends on what it reads. The server drops by event name,
which reaches every attached session at the next prod restart. The child drops
by what the frame carries, because that is where the frame is — and the third
rule needs the reader's own identity, which only the child has.

**Board state is server-owned, and Yjs only mirrors it.** The tasks live in the
sidecar-backed `TaskStore` (`tasks.ts`, JSON on disk). The `ws:<workspaceId>`
doc's `tasks` and `workspace` maps are a read-only PROJECTION of that store
(`task-projection.ts`), so the board renders in realtime without Yjs becoming
the record: the server observes those maps and reverts any transaction whose
Yjs origin is not its own `PROJECTION_ORIGIN` — firing no `task.*` event for
it, because events come only from store mutations — and reasserts the whole
projection from the store on hydrate, so a crash cannot leave forged board
state standing. `isBoardOwnedDoc` (`doc-ids.ts`) is the prefix authority for
which docs those are, `ws:` and `task:`, and none of them is ever file-bound.
**What a projected task carries is a size decision, because sync-step-2 is one
frame.** Opening a board costs the whole `ws:` doc, so the projection sends a
CLOSED task out in slim form: `task-row-slim.ts` drops the six fields only the
open panel renders, and `routes/task-detail.ts` hands the whole task back to the
one reader who opens it. `board-doc-compaction.ts` sheds the doc's delete set
at hydrate, which is safe for a `ws:` doc and nothing else because the sidecar
is the record and the projection is reasserted after load. Measured together
on the live board: 1.53 MB on the wire before, 0.22 MB after.
**Every page reports its own load, and a slow one raises.** The board, Home,
the review page, a doc, a mock, a diff and a folder each post one report per
page load naming the page type and the ms to its main content
(`workspaces-app/src/page-load-report.ts`; the doc bundle's three page types
are told apart in `doc/doc-load-report.ts`, and the mock's host page reports
from `widget/src/mock-host.ts`). A page on a board posts to that board's
`/workspaces/:ws/load-reports`; Home and `/review` post to `/api/load-reports`
(`routes/load-reports.ts`). `slow-load-alarm.ts` judges every report against
2,000 ms, raises through Sentry once per page type per board per five minutes,
and `page-loads.ts` keeps one server-wide log that
`GET /api/load-reports/slowest` reads back as the slowest load per page type
over 24 h for the daily health check. These reports are the only record of
load time: the browser's Sentry bundle (`sentry-boot.ts`) reports errors and
console logs, with no tracing, so `sentry-page.ts` and the measurements it fed
onto a pageload span are gone. That bundle loads `async`, and an inline buffer
in each shell (`server/src/browser-sentry.ts`) holds boot errors until it runs.
**A doc's text paints before its editor loads.** The doc entry carries only
the router, the socket and Yjs. When the doc syncs, `doc/prose-paint.ts` draws
the prose fragment as plain DOM with the editor's own classes, and
`doc/markdown-mount.ts` (the editor, the panels, the margin) loads behind it;
the editor then takes the painted element over in place
(`editor.ts`, Tiptap's `element: { mount }`), so nothing re-flows. The code,
media, redline and coach surfaces are each an `import()` for the same reason:
CodeMirror alone was ~720 KB of the doc entry, minified. `doc-image-path.ts` holds the
image-path helpers the paint and the editor share. The build strips comments
from the stylesheets it copies (`scripts/strip-css-comments.ts`), which took
`board.css` from 81 KB gzipped to 16 KB.
**An edit re-projects the rows it names, not the board.** The projection runs on
the server's one thread, so a whole-board pass per store event taxed every
request on a busy board. `board-row-sync.ts` writes only the rows an event or a
single-row verb names, and falls back to the full pass whenever something could
have moved an unnamed row: the attached agents or the identity roster changed,
a row's notes trim window lapsed, or a row appeared or left unannounced.
Heartbeats and tool calls name no row and project none.

**"Done when" is a field on the task, and it is what closes the task.** The
list lives beside the body rather than inside it, so the server can read it:
`task-done-when.ts` (`server`) is the verb family that writes the list, takes
a builder's report against it and takes the owner's word on a line only a
person can judge, and it is also what moves the task to done once every line
is met. `done-when.ts` (`core`) holds the wire type and the pure readers both
halves share — how many lines are met, which line is still open, and what the
chip on a line says — so `task-lifecycle.ts`'s refusal to close a task with an
open line and the board's own rendering cannot disagree about what "open"
means. The lines are the sixth field `task-row-slim.ts` drops, because a
closed task's row carries only the two numbers the pill needs. The routes are
`routes/task-done-when.ts`, one family, three paths under `tasks/:id/`.
`task-done-when-input.ts` joins the same group: it reads a list write's words
(and a line's `needs: 'owner'`, written when only a person can judge it) and
is re-exported by `task-done-when.ts`, so nothing moves across a boundary. A
line that needs a person asks nobody until its builder reports it `owner`;
the stall tick reminds that builder once every other line is met
(`review-items/done-when-ready.ts`), and the reminder renders in `mcp`
through `done-when-ready-line.ts`, beside the other line modules.
`done-when-refusal.ts` (`core`) sits beside `done-when.ts` for the one case
that is nobody's to check: a proof marked `refused`, or one whose words name a
permission refusal, says the agent was DENIED permission to run the check. It
is terminal, so the three sides read the same predicate — the report route
takes it in place of the link an `owner` line otherwise needs, the item
template says why the reader is holding it, and `review-gate.ts` drops a hold
that would tell the agent to obtain the fact another way rather than handing
that instruction back.

**A rebuild changes every clientID, so a tab that was away is told to start
over.** Sync is a state-vector exchange, and after a rebuild a reconnecting
tab's vector covers none of the doc — so the protocol asks it for everything
it holds and the doc re-inflates. `board-sync-gate.ts` refuses that merge and
`yjs-protocol.ts` answers with a third message kind (2, reset) which the board
turns into a reload. Scoped to `ws:` docs in the gate itself, never by where
it is called from: for a projection the client is never authoritative, and for
a bound document dropping its offline edits is data loss. Measured on a copy
of the live board: 0.97 MB held flat across three restarts, against 2.98 MB
and climbing without it.

**`<docId>.ydoc.pre-compact` is that compaction's one safety copy.** The first
time a board doc is compacted, the bytes that were on disk are written beside
it and fsynced before the rebuild is applied, and never overwritten
afterwards — a second compaction offering already-compacted bytes is refused,
because replacing the copy with them is the one failure that would look like
the backup working. A doc whose backup cannot be written is left uncompacted
rather than compacted with nothing behind it. Nothing reads the file: it
exists so the claim that compaction loses no content is falsifiable rather
than merely argued. **It is safe to delete once someone trusts the
compaction**, and it costs the doc's pre-compaction size once per board.

That is why editing a task chip inside a document does not write the task —
the edit is reverted a moment later and the board changes only through the
named REST routes, which is the consequence [security.md](security.md) records
under "The board's own live doc is different". Task BODIES are the deliberate
exception: each is an ordinary live `task:<taskId>` doc so every edit tool,
thread and anchor applies unchanged, and the store's `body` string is a
debounced snapshot of it.

## Layers inside `server`

**Imports point downward only** — a file may import its own layer and every layer below it, never one above.

| Layer | Where it lives | Why it is its own layer |
| --- | --- | --- |
| **HTTP** | `server.ts`, `routes/**`, `middleware/**`, `shells.ts`, `request-admission.ts`, `request-attribution.ts`, `socket-handlers.ts`, `board-sockets.ts` | The only code that knows about HTTP. Parse, admit, call one service, format. |
| **Services / stores** | `doc-store.ts`, `tasks.ts` and the `task-*` stores, `review-items/**`, `home-pane.ts`, `share/**`, `sharing-notice.ts`, `auth/**`, the `meeting-*` and `notes-*` families, `sse.ts`, `activity.ts`, `permission-grants.ts` | Owns durable state and orchestrates one change across stores and adapters. |

`permission-grants.ts` joins the services tier, and `settings-allow-file.ts`
joins the adapters. Together they are the server's only writer of the owner's
Claude Code settings. The service holds the ledger of which allow lines each
open task was granted (`permission-grants.json` in the data dir) and releases
them when the task closes. The adapter is the one module that opens the
settings file: it appends or removes allow lines only, keeps a backup, and
replaces the file in one rename. The route that triggers a grant is
`routes/task-grants.ts`. The trust rules are in
[security.md](security.md).

`event-origin.ts` joins `activity.ts` in the services tier: it is how a row
in either analytics log (`activity.jsonl`, a board's `events.jsonl`) says
which device a person's browser was on, and roughly where. `server.ts` opens
an `AsyncLocalStorage` context around each request, filled only for a browser
and closed when the request is answered, and the two log writers stamp
`device` / `location` from it. The browser half is two cookies:
`device-context.ts` (workspaces-app) writes them and asks for location at most
once per device, `core/event-origin.ts` is the cookie format both sides share.
Location is stripped from a share visitor's Activity tab and is never on the
live stream.

`edit-sessions.ts` joins them: it turns edits to a doc's body into
`edit_session` rows in `activity.jsonl`, one per author per sitting, closed
after 60s without an edit. It reads the transaction's origin to tell a person
on the doc's editing socket (stamped at the upgrade with the proven identity
and device) from an agent's REST edit tool, keeps the two in separate
sessions, and records counts and times only — never the edited text.

`library.ts` joins the Board box in the services tier: it builds a board's
Library — the meetings and files a person opens it to find — from the board's
docs, its project repo's markdown files (`fs-scan.ts`) and its mounts. It owns
no state; `routes/workspace-library.ts` answers the list and the one verb that
binds a listed file, through `doc-store.ts` like every other bind.
`library-location.ts` sits beside it and changes none of the picture: a pure
reading of where each board doc really lives by type — the project folder, a
project it may name, or the server's own storage — compared with the folders
the project named, for the Library's "Where files live" fold. It is handed
every filesystem answer already read, and emits folder names from the repo
root and fixed phrases, never a host path.
`doc-move.ts` joins the Doc store box under its `doc-*.ts` glob and changes
none of the picture: the migration verb that moves a board doc from the
server's storage into a mounted or meetings folder of the board's project. It
writes the file, rebinds the doc through `file-binding.ts`, claims the file's
address in `repo-registry.ts` so the Library above reads it as one document,
and moves a meeting's filing record with it. `routes/doc-move.ts` answers it.

`core/src/meeting-transcript-fold.ts` and `core/src/speech-lexicon.ts` join
the shared tier and move nothing in the picture, but they are the reason a
`meeting-*` module sits in `core` at all. The fold is a pure function from
the turns a meeting stored to the ROWS a person is shown; the lexicon is the
vocabulary it and `notes-idea-coverage.ts` both ask which words carry no
subject (it moved out of that file, which re-exports every name). They are in
`core` because two packages show a meeting's words as a list of rows and each
used to build that list itself: the server composes
`<docname>-raw-transcript.md` at stop (`formatRawSegment` in
`meeting-raw.ts`), and the board's Transcript fold composes the same grammar
in the browser off the REST record (`loadDocTranscript` in
`speaker-voices.ts`). Two implementations of one grammar are two answers to
"what was said", so both now call the one function. Neither module reads a
file, writes one, or touches the append-only JSONL and the audio beside it —
acknowledgement rides on the row it answered and a wall of words breaks at a
pause, while the record a replay lines PCM up against keeps every turn at its
own number. The meeting's two LIVE surfaces are deliberately untouched: the
strip holds a rolling window of three turns and cannot grow, and the live
zone is one flowing run of inline spans with no per-turn block, so neither is
a list of rows to fold.

`notes-timing.ts` joins the same `notes-*` family in the services tier and
changes none of the picture: it is where one meeting's per-tick latency is
recorded, opened only when the operator turns timing on. It holds no meeting
content — sizes, counts and durations — so it sits beside the notes modules
rather than with the stores that own durable text.

`notes-heading-store.ts` joins it too and changes none of the picture
either: it is the one small file per meeting that records which heading that
meeting's notes are written under, kept beside the meeting's transcript so a
restart mid-recording keeps writing under the section it opened rather than
opening a second one. Ids and a block id, no meeting words, so it sits with
`notes-timing.ts` rather than with the stores that own durable text.

`notes-quality-filed-store.ts` and `notes-quality-meeting-memory.ts` join it
in the same position and change none of the picture either. Between them they
are the quality filer's memory: the memory module holds the map of meetings
it has read, its bound and its eviction rule, and the store is one small file
per meeting recording WHERE that meeting's review item went — the pointer a
later leg revises or withdraws. It is durable for the same reason the heading
record is: a restart ends a recording leg and files the item at once, while
the browser resumes across the gap, so without a file on disk the meeting
ended clean in a new process that had nothing left to take back. Ids, a
verdict's counts and shares, no meeting words; and it is not
`notes-quality-store.ts`, which is the append-only series of READINGS the
daily health check rolls up.

`notes-section-tidy.ts` joins the same `notes-*` family and moves nothing in
the picture: it is the repair on a notes section that neither a prompt nor a
block edit can make — an empty paragraph under the heading, a topic heading
repeating the topic directly above it — and it is the one module here that
writes the document directly rather than through `applyBlockEdits`, because
neither block has an authorship to write through. Two callers, both after a
write has had the last word: the tick path in `meeting-notes-doc.ts` (topic
headings only) and `notes-cleanup-pass.ts` (both). It reads no transcript and
composes nothing.

`notes-group-tags.ts` sits beside it, in the same after-the-write position and
for the same reason: a run of notes that all came from one voice carries its
speaker tag on the bullet ABOVE them rather than on every line, and that is a
fact about the whole group, which is built across several ticks and so cannot
be decided from the one block an edit carries. It moves tags and never notes —
grouping stays by topic, which is `notes-regroup.ts`'s business — and the move
is reversible: a hoisted tag is written with the `g=<count>` marker
(`core/speaker-tags.ts`) that nothing else writes, so a group gaining a second
voice can hand every note its own tag back, and a group that has gained an
untagged note the fold cannot account for is unfolded rather than guessed at. Like the tidy, it writes the
document directly, and like the tidy it reads no transcript and composes
nothing.

`notes-cleanup-pass.ts` joins the same `notes-*` family and moves nothing in
the picture either: it is the at-stop tidy-up, and it is deliberately not a
second note-taking path — it reuses `NotesComposer`, the shared
`applyBlockEdits` and the same authorship rules, adding only the whole
transcript, a restraint directive and the gate that decides which of the
returned edits a cleanup is allowed to make. One route calls it
(`routes/meetings-calendar.ts`); nothing else does. `notes-cleanup-scope.ts`
is that gate, split out because it answers a different question: not "run a
pass" but "for a block the model has named, may this pass touch it at all" —
section membership, comment anchors, and whose material it is. Pure, or a
read of the doc; it composes nothing. `notes-cleanup-prompt.ts` is the third
piece and the only one that is not code: the restraint directive and the
transcript label, split off so that rewording the pass's instructions touches
no module that decides anything. It exports two strings, imports nothing and
changes nothing in the picture. `notes-cleanup-gate.ts` is the fourth: it
composes the other gate with `notes-edit-dedupe.ts` — the tick path's "each
note once" check — into the one order that is safe, gating the model's answer
BEFORE the dedupe may rewrite it and again after. It exists because the dedupe
invents edits, so an insert the gate would refuse could otherwise emit an
authorised delete beside it and take the section's only copy of a note with
it. One caller, the pass; nothing else imports it.

`meeting-stream-set.ts` joins that services tier inside the `meeting-*`
family and moves nothing in the picture: it is the fan-out one level below
`meeting-protocol.ts`, opening an engine session per audio stream and folding
two engines' independent turn numbering and speaker labels back into the one
transcript a meeting keeps. The relay still owns the lifecycle; this owns only
what two sessions collide on.

`meeting-silence.ts` joins the same family and changes nothing in the picture
either: it is one window and its resolver, the fifteen minutes of no settled
speech after which `meeting-protocol.ts` ends a recording itself. It sits
beside the relay rather than inside it for the reason `doc-store-timings.ts`
sits outside the doc store — a cadence with an environment override is a
decision a test reads and a reviewer checks, not a number buried in a
`setTimeout`. No state, no `Request`, nothing to schedule: the relay owns the
timer, this owns only how long it runs.

`meeting-takeover.ts` joins the same family and changes nothing in the
picture: one predicate, `samePerson`, and the frame and close code a socket
gets when the person it proved starts or resumes the same meeting on a newer
socket. The relay owns the takeover; this owns only who may make one. The
identity is the one the `/audio` upgrade proved and stamped as `data.author`,
never the start frame's own claim.

`race-deadline.ts` is a leaf under the services tier and changes nothing in
the picture: one function, `raceDeadline(work, ms)`, which settles when the
work settles or when the window runs out, and clears its own timer either way.
It sees no `Request` and holds no state. It exists because
`Promise.race([work, new Promise((r) => setTimeout(r, ms))])` leaves the
deadline's timer scheduled when the work wins, and a referenced timer keeps
the process alive — every shutdown drain in `meeting-protocol.ts` and
`recall-meeting.ts` held one, so a server with no meetings at all sat five
seconds past its own `stop()` before it could exit. Nothing else imports it
yet; a third drain would.

`meeting-namer.ts` and `meeting-titler.ts` join the same family and change
nothing in the picture: a meeting starts as "Meeting" and is renamed to its
topic from its own notes, only while nobody has named it. The namer is the
adapter (prompt, parser, one Haiku call, built only in `server-deps.ts`); the
titler decides when it runs and holds the guard, and `meeting-notes-doc.ts`
calls it from the sinks it already wraps. The one-time rename of the old clock
titles is `retitleClockTitles` in the titler, which `server.ts` starts once
the port is bound, beside the effort re-scoring pass. No route reaches it.

`notes-invented-links.ts` sits in the Meetings box beside `notes-edit-guard.ts`
and is the second deterministic refusal on the applier path: the guard says
which edits may touch the section, this says which links inside them the tick
was actually given, and `applyNotesUpdate` runs both before the store sees a
batch. Pure like the parser — a list of edits and a list of sources in,
rewritten edits and dropped URLs out — so `scripts/notes-eval.ts` counts the
same rule to report how often the composer invents an address.

`notes-scheme-links.ts` is the third, and runs BEFORE the other two on the
applier path. It answers a citation the note-taker wrote as a scheme rather
than as an address — `[the cap](task:Production cost target)`, or the same
words bare in parentheses — which the link check cannot judge because a
markdown destination may not contain a space. Resolved against the titles the
tick was handed it becomes the row's real link; unresolved it comes out as
words, and the `task:` residue goes with it. Pure like its neighbours, and it
adds no box: a list of edits and the tick's own catalogue in, rewritten edits
out.

The `notes-quality-*` family joins the same services tier and adds no new box
to the picture: `notes-quality-report.ts` and `notes-quality-thresholds.ts`
are pure (they read a markdown string and a transcript and answer counts, so
they belong beside `notes-edit-parse.ts` in the domain row on everything but
their filename), `notes-quality-coverage.ts` is the same tier and holds the
one check whose answer depends on something outside the notes — did what was
said reach a note — together with the third state that keeps a FAILED notes
reading from arriving as a confident 100%-uncovered verdict,
`notes-quality-verdict.ts` is pure too and holds one rule — whether two
readings of the same meeting differ enough to re-ask a person about, which is
counts exactly and rates to within a band, so that a share drifting a point
per leg does not re-judge a standing item — `notes-quality-store.ts` and `notes-tick-timing.ts` read and
write under the data dir the way the rest of the `meeting-*` family does, and
`notes-quality-review.ts` and `notes-quality-pass.ts` are the orchestration a
meeting's stop runs — read the notes, judge them, store the reading, file a
bad one on the task the doc belongs to, or on the doc itself when no task
links it. `notes-quality-filing.ts` sits between the pass and that filing and
is the one arrow worth drawing: the stop of a recording LEG is not the end of
a meeting (a dropped socket ends a leg and a resume carries the same meeting
on), so the pass hands its reading there and the filer holds it until the
socket layer says the meeting is over — one item per meeting, revised rather
than duplicated when a later reading changes. `notes-written.ts` joins the pure end of that
family and is the one box worth naming, because it answers WHICH BLOCKS ARE
THE MEETING'S: the note-taker's authorship marks wherever they sit in the
doc, union the section it opened. It reads a doc and answers markdown plus
whether that markdown is a reading at all, writes nothing, and both the
quality pass and the rerun harness address the notes through it — whole-doc
note-taking means a heading id no longer names a meeting's output, and a
reading that finds nothing in a document holding blocks says so rather than
answering the empty string a genuinely empty document would.
`notes-written-blocks.ts` sits beside it in the data-dir tier and keeps the
ids of every block a meeting wrote, across its legs, because each leg
releases the marks `notes-written.ts` reads. `meeting-notes-target.ts` is the
one new arrow on the notes sinks: it decides, once per meeting, whether the
notes go into the doc the meeting was started on or into a notes doc of its
own (when that doc holds a person's writing), and wraps the sinks'
`NotesDocStore` so every read and write lands there. Nothing under `routes/` is added: the
week's rollup rides the existing `GET /api/metrics` reply, for the reason
`uptimeSec` does.

WHAT A TIDY-UP DID, IN THE WORDS A PERSON READS, is
`core/notes-cleanup-report.ts` — a new DOMAIN-tier module in `core`, drawing
no new box: it takes the cleanup route's reply and answers with a headline,
the rules that dropped edits grouped with a count each, a recovery line and
whether another press could answer differently. It sits in `core` because
three surfaces ask the same question about one pass — the offer dialog
(`workspaces-app/meeting-cleanup-offer.ts`), `meeting:rerun`'s report file,
and the server's own log line — and a pass that changed nothing has to read
the same way in all of them. The reasons it groups are the gate's own
(`notes-cleanup-scope.ts`), carried out of the route on `refusals` /
`failures`. The two arrays are not written alike — the gate writes a sentence
per dropped edit, the applier writes its error code — so this module reads
each applier code into the gate's own wording as it groups. One fact then gets
one row however it was found, and nothing addressed to a person carries an
identifier. Its recovery line is the commonest rule a reader can act ON,
which is not always the commonest rule.

A BOARD EMBED — a doc line `::sfworks{block="goal-chart"}` showing a board
app's page beneath it — is `core/board-embeds.ts`, a new top-level core module
and no new box: the mapping's shape, the directive parser and the URL builder,
read by both the route that stores the mapping (`routes/workspace-embeds.ts`,
a field on the board record) and the editor decoration that draws the frame
(`workspaces-app/doc/board-embed-frames.ts`). The frame is a view decoration,
never a node, so the doc's text is the line as typed. An
entry names an app door or an allowlisted https origin; the allowlist lives
as `<dataDir>/embed-origins.json`, read per request by the route.

The NOTE-TAKER A DOC USES is five modules and no new box.
`core/notes-method.ts` is the shared vocabulary — the three methods, their
labels and prices, the default, and the parser that drops an unknown one
rather than defaulting it — so the chooser, the wire contract and the server
name the same thing. `notes-method-store.ts` keeps the choice per doc beside
that doc's meetings (`<meetingDir>/notes-method.json`), with who changed it
and when. `notes-method-composer.ts` is one `NotesComposer` that is three: it
reads the doc's method at the top of every compose, so a switch made while
the room is talking is honoured by the next tick and nothing in
`meeting-notes.ts` restarts. `notes-ledger.ts` is the two-pass note-taker's
first pass — a cheap extract that enumerates a tick's points so the compose
is handed a checklist — and every failure in it degrades to the original
rather than to no notes. `notes-section-fit.ts` is the DOMAIN-tier rule for
whether new minutes may write into the section a meeting already owns — which
it finds by the CLAIM the meeting recorded, not by a reserved heading name:
there is no `Meeting notes` container any more, and notes land under the topic
heading they belong to. Two modules joined that tier with it.
`notes-heading-level.ts` derives the level a topic heading is written at from
the document's own outline, so nothing in the notes path hardcodes `##`, and
`notes-heading-rename.ts` decides whether a `replace_block` on a heading is a
rename worth proposing — it comes out as a SUGGESTION whoever owns the block,
via the `propose` flag on `prose.applyBlockEdits`, because renaming the page's
furniture is a reader's call. All three sit beside `notes-edit-guard.ts` in
the row below, which is where the rename is wired in.
`notes-regroup.ts` joins that DOMAIN tier too, and is arithmetic rather than
policy: it reads the outline a tick is about to be composed against, finds the
topics whose flat run has reached the bar `notes-quality.ts` scores, and writes
the block ids into the prompt so the note-taker groups that topic instead of
extending it. It counts runs the way `flatBulletRuns` does, deliberately, so
the directive can never fire on a topic the eval calls fine. It counts a
SECOND thing beside the run — how many notes one heading stands over at all —
because a heading may swallow half an hour without ever holding five bullets
flat, and nesting cannot repair that: the reader meets the same stretch, in
groups. `notes-regroup-ask.ts` is the other half, split off it: the scan
decides what is wrong, the ask decides how to say it to a model, and only the
second is paid for on every tick at full rate. It offers the three remedies
Bryan asked for rather than one — a subtopic bullet with `nest_blocks`, a
subheading or a topic heading placed in front of the note a new part starts at
with `insert_before_block`, and the two composed in a single update, which is
what takes a stretch already on the page apart.
`notes-dictation.ts` and `notes-reason-ask.ts` join the same DOMAIN tier and
add no box. They are two more per-tick directives beside the regroup one. The
first notices a speaker dictating a document ("page one is…", "start with…",
"then…") and names the page heading, the next number and the edit. The
session keeps a small per-meeting memory of the last cue, the way it keeps the
idea ledger, so an ordering word counts only while a dictation is running. On
the tick after a cue it also folds a detail spoken about a page's last item
into that item, so a dash note cannot split the numbered list. The second
quotes any sentence of the tick that gives a reason, so the note for that
point keeps it. `notes-inversions.ts` joins the `notes-quality-*` family: a
pure check, run at the stop, that counts notes saying the opposite of their
source sentence. The count is recorded, not flagged.
`notes-unconfirmed.ts` joins the same DOMAIN tier as the half that settles the
guesses a meeting marked "(unconfirmed)" — it finds them and names their ids to
the cleanup pass, which counts what is left afterwards.

WHAT A MEETING COSTS is three modules and no new box, and the point of them is
that one price table answers both ends. `core/model-cost.ts` is that table —
dollars per million tokens per model family, the cache read and write
multipliers, and the two functions everything else calls (`dollars` for one
call's usage, `perHour` for a total over an elapsed meeting). It sits in core
because the chooser row, the meeting's own report and `scripts/notes-eval.ts`
all quote a price and must not each carry their own arithmetic.
`notes-spend.ts` joins the `notes-*` services family and is pure: a meeting's
recorded calls in, the total and the compose/capture split out, with any model
the table cannot price NAMED rather than counted as free. `notes-cost-store.ts`
sits with `notes-timing.ts` and `notes-heading-store.ts` in that same family —
one small file under the data dir (`meetings/notes-cost.json`) holding, per
note-taker, the last twenty finished meetings as a timestamp, a duration, a
dollar amount and a call count. No meeting content and not even a doc id, so
it belongs with the timing files rather than with the stores that own durable
text. The figure it answers rides the chooser's existing
`GET …/notes-method` read; no route is added.

`notes-edit-guard.ts` joins the DOMAIN tier below as well, and it moves no
boundary either: it is one function over values — a tick's edit list and the
block id of the section this meeting writes under, in; the edits that may be
applied and the reasons for the rest, out. It sits between the composer's
answer and `meeting-notes-doc.ts`'s call to the shared `applyBlockEdits`,
which is the one place a meeting can edit away the heading its own notes hang
from. Pure, so the rule is testable without a doc store; named here because
it is a REFUSAL the picture had no home for — a batch it empties is reported
as `guard-refused` and is deliberately not retried, unlike the write failures
beside it.

`notes-edit-bullets.ts` runs just before the guard, in the same tier: a
tick's edits and the outline in, the same edits out with every top-level prose
line made a bullet. It is the answer to "what if the model writes a note as a
paragraph", and no boundary moves. `notes-pending-clauses.ts` runs on its
output, same tier: a note's trailing "not finished yet" report comes off, and
a note that is only that report is dropped.

`notes-edit-dedupe.ts` sits right after it in the same flow and the same
tier: the guard's edits and the doc's outline in, the same edits out with a
topic heading the section already has re-addressed to it, a note it already
carries dropped or moved, and a `Decision:` label nobody spoke taken off. Pure
like the guard, and named for the same reason — it is the answer to "what if
the model writes it twice anyway", which no box above says.

`notes-edit-correction.ts` is the guard's own question split out, in the same
tier and the same place in the flow: whether a note the tick writes is the
speaker taking back one already there, judged on the tick's speech. The guard
asks it of a replace, and of an insert, which it turns into a replace of the
one note the insert withdraws. Pure, and no boundary moves.

`notes-idea-coverage.ts` joins the DOMAIN tier below, not this one, and it
changes no boundary: it is functions over values — sentences in, a verdict on
whether the notes carry them out — plus a per-meeting ledger the notes session
owns. It is named here only because it is the answer to a question the picture
did not previously have anywhere to ask: whether a tick's speech produced a
note, as opposed to whether it reached the composer.

`notes-missed-words.ts` joins the DOMAIN tier beside it and moves no boundary
either: a retried line and the notes so far in, the words of the line no note
carries out. The prompt builder calls it so the retry block names what is
absent rather than asking the note-taker to judge what is carried — the
judgement that let the reason of an "X because Y" line go while its point
stood.

`notes-recent-speech.ts` joins the same DOMAIN tier and moves no boundary:
the previous tick's speech and this tick's in, the tail of the earlier one out,
which the prompt builder shows as context the note-taker must not note again.
It exists because the cadence ceiling cuts a long answer into slices, and a
slice read alone has lost its subject.

`notes-coverage-judge.ts` is a services-tier adapter beside the meeting namer:
once a meeting is over, the quality filer's `amend` hands it the transcript and
the notes, and one Haiku call per stretch of speech says which points no note
carries. Its share replaces the lexical coverage reading on the item, so a
meeting that lost ideas is reported. No boundary moves: it is one more model
call behind the same key and consent as the composer.

| **Domain (pure)** | `task-owner.ts`, `task-fields.ts`, `task-row.ts`, `decision-shape.ts`, `safe-path.ts`, `workspace-path.ts`, `path-params.ts`, `diff-groups.ts`, `pause-ticker.ts`, `keep-moving.ts`, `owner-ask.ts`, `stall-gate.ts`, `unanswered-thread.ts`, `waiting-unfiled.ts`, `waiting-unfiled-review.ts`, `waiting-unfiled-frame.ts`, `ui-review-gate.ts`, `blockage-lift.ts`, `notes-edit-parse.ts`, `notes-prompt-build.ts`, `notes-prompt-cache-shape.ts`, `notes-invented-links.ts`, `notes-scheme-links.ts`, `notes-research-placeholder.ts`, `ask-detection.ts`, `notes-link-intent.ts`, `notes-idea-coverage.ts`, `notes-missed-words.ts`, `notes-recent-speech.ts`, `notes-edit-guard.ts`, `notes-edit-bullets.ts`, `notes-pending-clauses.ts`, `notes-edit-correction.ts`, `notes-section-fit.ts`, `notes-heading-level.ts`, `notes-heading-rename.ts`, `notes-dictation.ts`, `notes-reason-ask.ts`, `notes-inversions.ts`, `notes-unconfirmed.ts`, `notes-method.ts` (core), `notes-cleanup-report.ts` (core), `model-quota.ts`, `notes-notice.ts`, `notes-edit-address.ts`, `dispatch-request-event.ts`, `agent-listening.ts`, `claude-key-source.ts`, `project-profile.ts` | Functions over values: no clock, filesystem or socket unless passed in, so a rule is testable without a server. |
| **Adapters** | `transcribe-*.ts`, `recall*.ts`, `google-oauth.ts`, `summarize.ts`, `deploy*.ts`, `client-release.ts`, `push-notify.ts`, `share/cf-api.ts`, `share/keychain.ts`, `secret-store.ts`, `settings-allow-file.ts`, `git-diff.ts`, `sentry.ts`, `outbound-fetch.ts` | One vendor or OS facility each, behind an injected interface, so a swap or a test double touches one file and no state. |
| *Composition root* | `bin.ts`, `server-config.ts`, `server-deps.ts`, `start-contract.ts` | Reads the environment once, builds adapters, wires services. Beside the stack, not on top of it. `start-contract.ts` is the supervisor's half: the port, the data dir (required, no default) and whether a busy port is waited for (prod) or refuses the start; no start moves to another port. |

`outbound-fetch.ts` joins the adapters as the one facility every other adapter
reaches the network through. Each module that calls out still takes an
injectable fetch; its default is now one of the guard's three ways out — the
public path for an address from content, the fixed-host path for a vendor or
configured host, the loopback path for an attached dev server or this server
itself — and `check:outbound-fetch` fails on a bare `fetch` anywhere else in
the server. The rule is in [security.md](security.md).

`answer-coverage.ts` (server) and `answer-coverage-prompt.ts` (core) join
the Board group beside the review judge, split the same way and moving no
boundary. When a person types or speaks an answer to a review item that asks
more than one question, one Haiku call asks whether the answer covers them
all. That holds for every door an answer comes through: a ticket item's answer
route, an item declared on a comment (its answer route, or a plain reply
folded into an answer) and voice. An answer that leaves questions open is
stored as a partial answer, on the ticket item or on the comment's payload.
The item stays on the queue with a note naming what is left, and the filer's
`decision.answered` event or `thread.replied` frame lists it, as does the
lead's wake. The server module is the network call and
the rules for when it runs; it fails open, so the answer closes the item. The
core module is the prompt, the parser and the note, with no socket.

`supervisor-health.ts` joins Ops and moves no boundary. It is the health
check `scripts/serve.ts` runs against the server it supervises — one HTTP
request to a route that already exists, a verdict, and a restart ledger that
outlives the supervisor — so the server imports only its probe-marker
constant, and only so `sentry.ts` can leave the probe out of tracing.

`supervisor-restarts.ts` joins Ops beside it and moves no boundary. It is the
half of that check which has to remember something across a process: the
three-per-hour limit, the `supervisor-restarts.json` ledger it reads, and the
first-bind grace the ledger lengthens. The split is one-way —
`supervisor-health.ts` imports it and nothing imports back — and it exists
because the two halves answer different questions: the health file reads a
socket, this one reads a file written by a supervisor that no longer exists.
`server-starts.ts` reads the same ledger, and now reads its `restarts` field
rather than a bare array.

`liveness.ts` joins Ops and moves no boundary. It is a pure description of
whether THIS process is bound and owns the machine's discovery slot, which
`GET /api/deploy` carries beside the deploy verdict. It sees no `Request` and
does no I/O: `bin.ts` constructs the one real discovery reader, on the same
seam rule as `deployer` and `secretWriter`, so no test resolves the
developer's own `~/.claude`.

`event-loop.ts` joins Ops and moves no boundary. It is an observer plus a
helper, importing nothing from the subsystems it watches: a lag monitor that
reports a turn which held the single JS thread past a threshold and names the
requests in flight at the time, and `timeSlice`, the budget a long pass uses to
hand the loop back. `server.ts` registers each request at the front door and
arms the monitor beside the other running-board timers; `doc-suggest-ops.ts` is
its first `timeSlice` caller. The reason it exists is that the 2026-09-16
outages were legible only as a 404 that took 56 seconds — the block itself was
recorded nowhere, and whether a stall was a synchronous pass or the OS
descheduling the process could not be told apart. A stall with nothing in
flight is that second thing, and the line says so.

`memory-log.ts` and `memory-footprint.ts` join Ops and move no boundary. They
write the `[doc-store] mem` line: the footprint macOS counts, read every 30
seconds through `bun:ffi`, printed on a 64 MB move or every five minutes, with
the window's requests by route family and its busiest doc-store activator.
Each line also carries the JS heap, and every ten minutes one carries the
heap's commonest object types and biggest growers, so heap growth can be told
from native growth. `doc-store.ts` owns the sampler and `server.ts` counts each request at the
front door; neither module imports a subsystem.

`doc-residency.ts` joins the doc-store group and moves no boundary. It is the
eviction WINDOWS as a pure function over each resident doc's clocks — a week
for a doc a person's editor left, for at most 500 such docs, and thirty minutes
for anything else — while `doc-store.ts` keeps the holds, the flush and the
sweep. It replaced a flat two-day window after prod's idle event-loop blocks
of 2.4-2.7s (2026-09-28) under swap: every resident doc is heap a full GC
walks, ~62KB each, so the count is the lever. The same fix gave the
`event-loop.ts` block line the CPU, major page faults and heap across the
block, so the next idle block says which of GC, page-in or descheduling it was.

`doc-catalog.ts` joins the doc-store group and moves no boundary; the diagram's
`doc-*.ts` already draws it. It is what `DocStore` answers about a doc without
opening it — the listing rows, the alias table and the `.ydoc` mtimes a listing
reports as activity — moved out of `doc-store.ts` whole, behind a host of
thunks like the other collaborators. `DocStore` keeps `list`, `threadCounts`
and the rest as one-line forwarders, so no caller changed.

`doc-create-conflict.ts` joins the doc-store group and moves no boundary; the
`doc-*.ts` glob draws it. It decides whether a create naming an existing doc
would repoint that doc to another file or type, which `POST
/workspaces/<ws>/docs` then refuses with 409 `doc_exists`.

`server-starts.ts` joins Ops and moves no boundary. `bin.ts` records every
start of the process in `server-starts.json` beside the deploy log: once at
start, and again once serving, with the deploy it confirmed. It reads the
watchdog's restart ledger at that moment, because the ledger keeps only an
hour. `scripts/server-starts.ts` (`bun run starts:report`) reads a day of
those records back for the health check, and the planned uptime report will
use the same record to label outages as deploys.

`dependency-install.ts` joins Ops beside it and moves no boundary. It is the
`bun install --frozen-lockfile` runner, taken out of `deploy.ts` so the deploy
verb and `scripts/serve.ts` run one copy: the verb installs before the restart
it schedules, and the supervisor installs before it builds or boots, which
covers the manual pull-and-kickstart fallback the verb never sees.

`supervisor-reap.ts` joins Ops beside them and moves no boundary. It is the
SIGTERM-then-SIGKILL sequence `scripts/serve.ts` runs on its children before it
exits, moved out of the script so a test can drive it, and it imports nothing
from the server.

`supervisor-hang-capture.ts` joins Ops beside them and moves no boundary. It is
what the supervisor records before it restarts a server that is listening and
not answering: a `sample` of the child into the data directory, the machine's
swap and memory-pressure readings, and the child's RSS and page-ins.
`supervisor-health.ts` imports its budget and runs it through an injected hook;
it imports nothing from the server.

`claude-key-source.ts` joins the DOMAIN row and moves no boundary. It
decides which Claude key a process may spend: prod's Keychain item when the
environment carries the prod launchd job's label in `XPC_SERVICE_NAME`, and
the eval item everywhere else. `summarize.ts`'s `resolveKeyFrom`, which every
Claude adapter already calls, asks it; `scripts/eval-credential.ts` asks it with
the marker stripped. The environment and the Keychain reader are parameters.

`project-profile.ts` joins the DOMAIN row and moves no boundary. It decides
whether this process is a project server (a Fly machine, or one naming
`CW_PROJECT_PROFILE`), which features its profile turns off, and which
credential names it must not hold. On one, `summarize.ts`'s lookup reads only
`CW_ORG_ANTHROPIC_API_KEY`, `share/keychain.ts` runs no `security`, and
`server-deps.ts` strips the other names from the environment before building
anything. On the Mac every answer is "nothing changes".

`claude-key-slot.ts` joins the SERVICES row and moves no boundary, because
it holds one piece of process state the domain row's purity bar would not
take. It names the slot a credential came out of — the Keychain service or
the environment variable, plus the role `prod` or `eval` — and keeps the
latest answer each call path resolved, so `bun run keys:trace` can ask a
RUNNING process which name every adapter consulted rather than inferring it
from `claude-key-source.ts`. The slot rides `NotesCallUsage` into the
meeting timing ledger, which is how a stored row says which key paid. It
imports the service names from `claude-key-source.ts` and nothing else; a
value never reaches it, and nothing derived from one is ever produced.

`model-quota.ts` and `notes-notice.ts` join the DOMAIN row and move no
boundary. The first answers one question about a refused model call — is the
account out of quota, or is this request's own problem — from a status and a
body, and re-emits nothing from either. The second turns a verdict into the
block edits that put one sentence in the meeting doc and later take it away.
Both are functions over values, which is the point: what a person in the room
is told when the note-taker stops is now testable without an API or a Yjs doc.
`notes-notice.ts` was `notes-quota-notice.ts` until it grew a second
sentence — a tick whose words could not be written — and the rename is the
whole of that move: announce once, adopt an existing one, retract when it
stops being true, believe nothing until the write is accepted. One mechanism
taking a `NoticeKind`, not a copy of it per sentence.

`notes-edit-address.ts` joins the same row for the same reason, and sits in
the same place in the flow as `notes-edit-guard.ts` — between the composer's
answer and the shared `applyBlockEdits` — but on the far side of the write.
The guard reads edits BEFORE they are applied and drops the ones the notes
cannot survive; this reads the applier's own VERDICTS afterwards and puts back
the words of any edit that failed because its ADDRESS was wrong (the block is
gone, or it is a bullet where a heading was wanted), re-addressed to the
meeting's own section. It is what stops a repeated addressing mistake costing
a meeting every note after the first. Pure: edits and verdicts in, edits out.

`dispatch-request-event.ts` joins the DOMAIN row and moves no boundary. It
builds one event — the moment a lead asked for a builder lane — and hands it to
an injected sink through an injected scheduler, so the route that calls it gains
no write it waits on and no failure it can inherit. It is named here because it
answers a question the picture had nowhere to ask: the board recorded a row
going in-progress and a lane starting, and nothing in between, which made the
largest measured wait in the pipeline unattributable. `scripts/dispatch-timing.ts`
is the reader.

`dispatch-reports.ts` joins the SERVICES row beside `dispatch-registry.ts`,
and draws no new boundary: `routes/dispatch-and-notes.ts` is its only caller
and the task store is its only collaborator, reached through a one-method sink
it is handed. It is named here because the two dispatch modules answer
different questions and are deliberately not one. The registry is about a lane
being HELD — a worktree, a watcher, a slot against the parallelism cap — and it
closes a dispatch the moment the worktree or the task is gone. A report is
written at the END and has to outlive the lane it describes, because the lead
reads it after the builder has stopped. It owns one decision nothing else can
take: a SECOND report on the same task-and-commit builds no event at all, so a
re-sent report cannot reach the SSE fan-out for any subscriber on any bundle.
`dispatch.reported` is the one board event of the dispatch pair that IS
broadcast — its twin `dispatch.requested` is telemetry nobody acts on, this is
the lead's cue to read the record.

`agent-listening.ts` joins it too, and draws no new boundary — it is the one
question the presence strip was missing. The roster has always answered *did a
session sit down here*, which is durable and outlives the session; whether
anybody is there is answered by the stream that session's MCP child holds, and
the SSE bus already knew (`agentsOn`). The module shapes that set into the
frame the board reads, so `/workspaces/<id>/agents` can say `listening` per row
and a circle is drawn only for somebody present. The field itself is derived
inside the store's own reads, where the visitor allowlist can name it. This
module reaches for no bus of its own, which is why it sits here and not beside
`sse.ts`.

`sse-writer.ts` sits beside `sse.ts` and draws no new boundary either: both
streams (`sse.ts` per doc, `sse-mux.ts` per tab) write through it instead of
straight onto their controllers. It hands one stream's queued frames to its
socket per event-loop turn, because under Bun on macOS a chunk written to a
second socket in the same turn is held for about 100ms. That is the delay the
board's wake frames and every comment broadcast were paying on the machine
prod runs on.

`page-nudges.ts` sits beside `sse.ts` too. It tells an open page that a list
it read over REST is stale: a board's Library and members (`library.changed`,
`members.changed` on `ws~<board>`), a review's sidebar (`attachments.changed`
on `ws~<set>`), the voice page's agents (`voice~`) and the prompts page
(`prompts~`). It listens on hook slots the stores already expose or gained for
it — `DocStore.onIndexChanged`, `TaskStore.onBoardDocsChanged`,
`ShareLinks.onSaved`, the bus's tap and `onAgentStreams` — and chains onto
whatever held them. Frames name only the list, are transient, coalesce per
150ms burst and skip agent streams. On the page side, `workspaces-app/src/set-live.ts`
is the one stream a doc page opens for its review's sidebar; the board, voice
and settings pages listen on streams they hold already or open one each.

`folder-watch.ts` covers the one change no store announces: a file created,
deleted or renamed straight on disk in a review's folder. While a page holds
`ws~<set>` (the bus's `watchStreams` and `pagesOn`; agent streams do not
count) it keeps one recursive `fs.watch` on the folder root, and on a settled
burst compares a names-only listing (`git ls-files`, else an async `readdir`
walk) with the last one. A changed listing runs `refreshWorkspace`, whose
`onSetRescanned` sends the same `attachments.changed`. A diff review based on
the working tree compares its diff instead (`git diff --numstat` against the
stored base, path, status and counts per file), so a tracked file's first
edit joins the list and a save that moves a count redraws it, while a save
of the same bytes sends nothing. The watch closes with the last page, and at
most 32 run at once. On Linux under Bun before 1.3.11 the watch is a
one-second timer instead (`watchCanWedge`): there, one inotify read of more
than 128 events leaves every `fs.watch` in the process deaf.

`path-params.ts` joins that row for the same reason and from the same problem:
it decodes one path segment, answering rather than throwing on a stray `%`, and
`server.ts` calls it once at the front door so no route can be reached with a
segment it would die on. Pure by construction — a string in, a string or
`undefined` out — which is why it sits here and not beside the HTTP code that
happens to be its only caller today.

`workspace-path.ts` is the newest name in that row and it sat under `routes/`
until the canonical-routes cutover. It parses `/workspaces/<id>/…` and holds the
one list of which of those addresses are HTML pages — and the reason it moved is
that it now has TWO readers on opposite sides of the import rule:
`routes/shell-static.ts`, which serves those pages, and
`middleware/workspace-scope.ts`, which must pass them over. It answers no
request and returns no `Response`, so it belongs beside the other functions over
values; leaving it in `routes/` would have meant a module outside `routes/`
importing out of it, which is the direction `check:imports` exists to refuse.

Four top-level modules keep a doc page readable with no network, and none of
them changes a layer. `doc-cache.ts` is a store adapter: the browser's
IndexedDB copy of each opened markdown doc, written only once a server sync
has given it a state vector to check against, tagged with the session's
identity and cleared when another identity answers. Each edit made on the
page is appended to a second database (`cw-doc-cache-updates`) as it happens,
in a transaction committed at once (one left to auto-commit was measured
lost to a reload on a slowed CPU),
and the full copy written 800ms later drops the edits it covers, so a reload
loses at most the keystroke in flight. `doc-cache-boot.ts` is
the controller tier between the router's two hooks and that store: with a
copy, the doc's meta comes from it and the socket's doc is seeded from it
before the socket opens; core's `connect` takes an `acceptServerState` option
so a copy the server's history no longer covers is refused, not merged.
`offline-worker.ts` registers the same root-scoped `/sw.js` push enrolment
uses and tells it what the page loaded, and `sw-offline.ts` is the worker's
offline half, bundled into `sw.js`: a network-first doc shell with a kept
fallback, and the `/app/` bundles. The worker holds no doc content and answers
no API read.

`workspaces-app` layers the same way — entries, controllers, views, models,
transport — and its models are DOM-free, which is what lets `board/board-model.ts`,
`board/board-review-model.ts` and `board/board-presence-model.ts` be tested without a
document. `suggestions/` sits in the editor tier rather than inside `redline/`,
because Redline is the change view and a suggestion is the proposal: the chip
and the doc-level pending badge render on the plain markdown surface and on the
board's task-body editor, neither of which mounts a redline module. `new-indicator.ts` sits in the view tier as the doc's one report of what the reader has not seen: `comment-hints.ts` measures (threads off screen, and the tinted note blocks `settle-wash.ts` marks) and this draws the two pills. It replaced four controls that counted overlapping halves of that fact — the edge markers, the off-screen hints and the top bar's asks chip — so `recent-note-markers.ts` is gone. `recent-note-cards.ts` joins the same family for the wide layout's other half: it builds and ages the "who wrote this, and when" card and hands it to `redline/markup-margin.ts` to PLACE, which is the one direction that keeps a single stacking pass over the balloon column. `reading-hold.ts` is the same family's other half and changes none of the picture: a view-tier module, mounted by `doc/doc-margin.ts` on the `#editor` scroller, that keeps the reader's topmost visible line on its pixel while an agent writes above it — the page's own scroll anchoring, because Safari had none before 27 and Chrome's anchors a node of its own choosing rather than the line being read. It imports nothing but `mount-scope.ts`. `meeting-live-hold.ts` joins the meeting family in that same view tier and
changes none of the picture: it is one screenful of geometry that
`meeting-live-zone.ts` owned until the zone crossed 500 lines, holding the
live transcript still across the frame a settled chunk splits off on. Nothing
but the zone imports it. `meeting-speaker-pill.ts` joins it in the same tier
for the same reason — the zone is back on the 500-line bar — and holds one
decision that is not the zone's: a speaker pill is a rename BUTTON where
somebody handed in a way to record a name and the plain span it always was
where nobody did. Nothing but the zone imports it either, today; the strip's
own pill (`meeting-feed.ts`) is the obvious second caller. `meeting-source.ts` sits beside `meeting-audio.ts` in the same family and changes none of the picture: it is where the strip's chosen source — the microphone, or the Mac's own audio through Chrome's share picker — becomes a media stream, split out because the capture module sits on the 500-line bar. `meeting-capture-set.ts` joins that family for the meeting that opens BOTH: it is the tier above one capture, opening each stream in turn and deciding what a meeting runs on when only one of the two doors was answered. It changes no layer — it is a view-tier module calling the same `startMeetingCapture` a single-source meeting always did — and it is named here because the strip now talks to it rather than to the capture directly. `meeting-reconnect.ts` joins the same family one tier below the strip and changes no layer either: it is the policy a dropped audio socket is retried under — how long to wait, when to stop waiting, and the two sentences the strip shows while it happens — with no DOM, no socket and no timer in it, so `meeting-strip.ts` owns the doing and this owns the deciding. Three modules join that family for the capture that dies while the meeting is still running, and they split noticing from deciding for the same reason: `meeting-track-watch.ts` is the noticing — it watches a capture's tracks on the audio graph's own block clock and reports the first loss once, with no DOM, no timer and no policy in it, because a `MediaStreamAudioSourceNode` downstream of a dead track keeps delivering silence and nothing else in the capture path was listening. `meeting-stream-health.ts` is the deciding: which streams can be reopened without a person (a microphone can, the Mac's audio cannot — the share picker is a modal no page may open by itself), what the strip says while one is gone, and what the button is called where only a press will do. Both are pure, so the strip owns every side effect. `meeting-room-audio.ts` changes none of the picture: it is the room-processing constants and constraint builders lifted out of `meeting-audio.ts`, which sits on the 500-line bar, and `meeting-audio.ts` re-exports them so no caller moved. `meeting-record-face.ts` joins the same family one tier below the strip and changes no layer: it is the vocabulary the Record button wears — which word stands for each source and each voice count, what the control reads in each state, and the full list of faces the hidden sizer reserves the button's one width from. Pure, with no DOM and no state in it, because the two facts it names are the two that decide what is recorded and what is billed, and a button that got them wrong is how a paused meeting came back solo on 16 September. `meeting-transcript-panel.ts` joins the same family in the view tier and
changes none of the picture either: it is the Transcript fold the start panel
grows once a meeting has ended, split out of `meeting-chooser.ts` — which sits
on the 500-line bar — because that panel is where every billed choice for the
NEXT recording is made and this is a report on the last one. It reads the
meetings route the cast list already reads, at the tap rather than at mount.
`meeting-notetaker.ts` joins the same view tier for the same reason and
changes no layer: it is the Note-taker fold in that panel — which of the three
note-takers this doc's minutes are written by — split out of
`meeting-chooser.ts` because that file sits on the 500-line bar and this is a
section with its own state and no dependency on the rest of the form. It is
also the client half of the `notes-method` route, so a switch made while a
meeting is running goes over the meeting socket and one made at rest goes over
HTTP.
`meeting-cleanup-offer.ts` joins the same view tier and changes no layer: it
is the one button a finished recording leaves at the end of the prose, asking
whether to read the notes once more, plus the POST that press makes. It is
the client half of `notes-cleanup-pass.ts` on the server, and it is separate
from the strip because the strip is chrome for a meeting that is HAPPENING
and this exists only once one has stopped.
`meeting-tidy-line.ts` joins that view tier beside it and changes no layer
either: it is the SAME offer for the ending nobody was present for. A
recording that timed itself out for silence raises no dialog — there is
nobody there to answer one — so the tidy-up becomes a control on the strip's
idle line, beside the sentence saying the recording is over. It holds the
request and the small state machine that turns a reply into a label; the
strip draws it and owns every side effect. What the reply MEANS it does not
decide — `readCleanupReply` in `packages/core` does, for this line and for
the dialog both, so the two surfaces cannot name one reply differently. The
line takes that report's headline and its `retry`, and leaves the grouped
per-edit reasons to the dialog, which has a card where this has one row.
`notes-link-affordance.ts` joins the editor tier beside
`task-link-chips.ts`, and is the one plugin there that WRITES: the chips are
render-time and change nothing, while accepting a note's suggestion or undoing
a link edits the stored doc and calls the board. `yjs-observer-guard.ts`
joins the editor tier too and changes none of the picture: an extension in
`editor.ts`'s base list that keeps a transaction dispatched from inside a
Yjs observer from writing the editor's not-yet-redrawn doc back over the
change being observed, which is how a reconnecting tab re-inserted an
agent's deleted blocks. `doc-image-src.ts` joins the editor tier as well:
the block image in `editor.ts`'s base list, which fetches a relative `src`
from the doc's own folder (`routes/doc-assets.ts`) while the node, and so the
`.md`, keeps the path as written. `doc-image-upload.ts` beside it takes a
pasted, dropped or picked image file to that route's POST, which stores it in
`images/` beside the `.md` through the server's `doc-image-store.ts` (one of
the `doc-*.ts` the diagram draws), then inserts the path it answers.
`doc-image-retry.ts`, which that block image installs, asks again for an
image whose file was not there yet, so it appears once the file lands without
a reload; it changes the DOM's `src` only. `doc-image-versions.ts`, which it
also installs, points each such image at `?v=<mtime>` from the doc's
`imageVersions` map, so an overwritten file is a new address no cache can
answer with the old bytes, and an open page shows it without a reload. The
server's `doc-image-versions.ts` (a `doc-*.ts` the diagram draws) writes that
map from a sweep over docs with a page open, and core's `image-versions.ts`
holds the map's name and key, so the two sides cannot disagree about either.
`comment-delete-guard.ts` and
`mass-delete-undo.ts` join the editor tier and change none of the picture:
two extensions in `editor.ts`'s base list. The first refuses Delete over a
selection spanning blocks right after a tap on a comment, which is how a
select-all reached from a comment wiped a doc; the second puts up an Undo
toast after one local edit removes most of the doc. `core` is three tiers: wire types, the document model (`prose-*.ts`,
`anchor/**`, `redline.ts`), then the rules both sides must compute identically
(`review-item*.ts`, `effort-*.ts`, `goal-effort.ts`, and
`note-suggestion.ts`, which is how a note's written "did you mean this row?"
is spelled — server writes it, browser reads it back, one definition so the
two cannot drift into a suggestion nobody can accept). The `review-item*.ts`
glob is deliberate: `review-item-look-ask.ts` is the gate's two English
heuristics lifted out whole when the gate crossed the line, and it changes no
boundary the diagram draws.

`review-hold.ts` is the newest member of that same glob's neighbourhood, and
it is there for the usual reason: the BOUND on what a hold may say — a quote
must be the item's own words, a diagnosis may carry no figure the item does
not state — is checked on the server before the hold is sent, while the
derived note a card draws from a stored verdict is read in the browser. One
definition, two readers, no boundary moved.

`review-refusal.ts` sits beside it: the five fleet rules that answer an ask
outright (spend of $50 or less, a push or merge the ship method already
consents to, a reversible implementation choice, a fact the agent can read,
a decision whose options only re-ask whether to do work the reader already
requested),
the block of the judge's prompt that teaches them, and the one fixed sentence
per rule a refused filer is told. The judge's prompt reads it, the gate
records a refusal under its rule name, and the stored verdict is read back on
both sides. `review-judge-sentence.ts` is the judge reason's one-sentence clip,
moved out of `review-judge-prompt.ts` to keep that file under the line limit.
Neither moves a boundary.

`review-blocks.ts` and `review-stale.ts` (core) join the same contract, and
`review-stale-notify.ts` joins the server's Board group; none moves a
boundary. `review-blocks.ts` reads a payload's `blocks` field — the asker
is idle until the answer — which sorts the item first on Home, gives its
row and its one push the "Stopped until you answer" line, and marks its
answer `blocking` in the answer ledger, whose week `GET /api/metrics`
reports as `blockingWait`. `review-stale.ts` decides from the thread alone
that an open ask stopped applying (its anchor orphaned, or the asker's own
later reply settled it), so `review-queue.ts` drops it and the thread card
marks it, with nothing written. `review-stale-notify.ts` is the one half that
cannot be a read: it listens for the posted comment and the edit-triggered
re-anchor sweep that make an ask stale, and sends its asker one addressed
`workspace.review_item_stale` frame carrying the withdraw call.

`secret-name.ts` joins that third tier for the same reason, with the two
readers furthest apart in this repo: the server's writer spells the stored
name when it runs `security`, and the MCP tool descriptions tell an agent the
name to read back. Neither package can import the other, and the two used to
be hand-written copies of one prefix — one in code, one in prose — so a rename
could leave every agent reading an entry that does not exist. It changes no
boundary the diagram draws; it holds names and one command string, and no
value passes through it. `secret-line.ts` sits beside it: the command line a
value is stored with, its budget, and whether a value fits — measured by the
server's writer and by the board's secret form before it sends. Apart from
`secret-name.ts` only so the MCP bundle, which never measures a line, does
not carry the budget.

`mock-swap-noise.ts` joins that third tier for the same reason and an unusual
pair of readers: the widget's mockup swap raises a flag there while it inserts
a script it is about to retry, and the page's Sentry init reads it in
`beforeSend` to drop the redeclaration the swap already recovered from. They
are separate bundles that share nothing but the page, so the flag's name and
the "is this a declaration collision" test have to have one definition — and
the narrowness is the point, since a collision nothing recovers still files.

`meeting-streams.ts` belongs to core's wire-types tier beside `meeting.ts`, and
is there for the usual core reason: a two-stream meeting's group names and
namespaced speaker labels are rendered by the browser, written by the server
and read back by the notes composer, so one spelling has to serve three
processes.

`meeting-parse.ts` joins that tier too and moves the boundary rather than the
picture: `meeting.ts` keeps the VOCABULARY — the frame shapes, the capture
modes, the engine names, the bounds — and this holds the reading of an
untrusted frame against it, which is a different job under a different rule.
It imports from `meeting.ts` and never the other way, because both sides of
the socket use the types and only the server reads the frames. It was split
out when a new frame took `meeting.ts` past the 500-line bar.

`speaker-name.ts` sits in that same wire-types tier, and joins the picture
without changing it: what a voice is CALLED — the placeholder until somebody
names it, and the normalisation that keeps a stale display string from being
read back as a name — was a function inside `meeting.ts` until the rules
outgrew it. Four processes render it (strip, notes editor, notes composer, raw
transcript), which is the same reason `meeting-streams.ts` is here.

`footnotes.ts` belongs to that document-model tier too and does not move the
picture: it is the grammar of a `^[a note]` inline footnote — where the notes
are in a line, whether the author wrote "Unconfirmed", and which words a note
is about. Nothing about a footnote is stored, so this is a pure text question
asked at parse time (the inline parser skips a note's body rather than reading
citation punctuation as emphasis) and again at render time by the editor's
decoration plugin, which is why the answer lives in `core` rather than in
either caller.

`prose-integrity.ts` belongs to that document-model tier and does not move the
picture: it is the check the server runs after a write, asserting the live doc
holds no markdown syntax that should have become blocks. It is named here so the
next reader knows a new `prose-*` module was placed rather than missed.
`prose-keep-source.ts` sits in the same tier and does not move the picture
either. It is the serializer the file write-back uses. It keeps the file's own
bytes for every block an edit did not touch, so editing one paragraph rewrites
one paragraph, and a note added to a list rewrites only that list item. A block
counts as touched when its content changed, whoever changed it. Before it, the
first edit re-serialized the whole file, which in an `.mdx` post joined the
`import` lines onto one line.
`prose-mdx.ts` is the other half of that fix, in the same tier. For a file
ending `.mdx` it finds each JSX component, `{…}` expression and import run,
and the parser stores it as a code block whose language is `mdx-flow` and
whose text is the exact source lines. A component is then one block the
writer serializes byte for byte, not a paragraph that an edit could reflow.
`prose-mdx-retype.ts` sits beside it and does not move the picture. A doc
parsed before that grammar holds its components as paragraphs, and once a
flush had written one onto a single line, the doc and its file serialized
alike, so the attach never re-read it. The attach now re-types each such
paragraph in place into the block the grammar makes, with the same text, so
the file does not change.
`prose-image-line.ts` is the same repair for images and does not move the
picture. An agent's text edit could leave a standalone `![alt](src)` line as
paragraph text, which serializes to the same line as an image node, so no
reconcile rebuilt it. A doc now promotes such a paragraph to an image node
when it loads and when the edit writes it; an open thread in the paragraph
holds it as text until that thread is resolved.
The editor draws that block through four client modules beside
`mermaid-code-block.ts`, and they do not move the picture either.
`mdx-flow-block.ts` is the node view and the plugin that makes the block
read-only. `mdx-preview.ts` reads a component's props with a literal parser,
never by running them, and shows a component's title and words.
`mdx-chart-props.ts` takes those props by shape rather than by component
name — a `series` of x/y points is lines, a `data` list of label/value rows is
bars — and `mdx-chart.ts` draws what it returns as SVG whose every string is a
text node. The two were one file until the drawing had to follow the published
site's chart: a band shades a stretch of x over the whole plot rather than a
y range, each line carries its name and last value at its own end instead of a
legend below, an indexed chart's reference line is drawn and labelled, and the
component's own `width` decides the drawing's width. The drawing is now four
files: `mdx-chart.ts` draws lines, `mdx-chart-bars.ts` draws bars,
`mdx-chart-waterfall.ts` draws a waterfall (a `data` list whose rows carry a
`kind` of start, step or end, each step floating between running totals), and
`mdx-chart-svg.ts` holds the SVG helpers they share. None of the four changes
the picture above. `mdx-chart-props.ts` also uses the site's defaults (horizontal
bars, percent) and lists every prop the preview does not draw, or that the site
itself ignores, so `mdx-preview.ts` can print them under the chart.
A `<PlotChart>` is read by name instead, and does not move the picture.
Its props are an Observable Plot spec, and `packages/core/src/plot-spec.mjs`
turns them into a chart. It is plain JavaScript that imports nothing, because
other repos copy its bytes. Every mark, transform and pointer it names must be
on an allowlist, as must every reducer a groupX, groupY or binX `outputs`
names, and every `data` reference must be a key or an inline array, so a bad spec throws before any Plot function runs. The file also holds what
makes a chart look and behave the same on every site: the house style (font,
grid, axes and palette, each a CSS variable with a fallback), three presets
that expand into ordinary marks (a preset's series take Observable 10
unless it marks them `ordered`, when they take the sequential ramp; and
stackedArea and lines draw `events` as dashed rules labelled at the top), named formats in place of functions, and
`renderPlot`, the one call each page makes. `renderPlot` draws a chart at
its container's width and the spec's height, and draws it again when that
width changes, so a narrow column gets a narrower chart with the same 13px
text; under 600px it also drops explicit x ticks, keeping the first, until
no two labels overlap, and a stacked chart names each series inside its
own band and its goal above the rule, so the right margin goes to the data.
At 600px and wider a stacked chart's end labels are set in ink beside a dot
of the series' colour, and labels whose bands are too thin to keep them
apart are moved apart on y around where they want to be (`spreadEnds`).
A lines chart's end labels are set in ink too, at every width, each beside
the dot of its series' colour that ends its line, because no Observable 10
colour reaches 4.5:1 as text on the paper; the same `spreadEnds` moves them
apart while the dots stay on the lines, and the baseline label is placed
against where they were moved to.
A band label's width is estimated glyph by glyph against Chrome's system-ui
widths, because a thin band's level window is often only a few px wider than
its name. The file's first line names its version and the
sha256 of every byte after that line, so a copy that has fallen behind shows
in the line a site compares, or in `tail -n +2 plot-spec.mjs | shasum -a 256`.
`bun run plot-spec:stamp` (`scripts/plot-spec-stamp.ts`) rewrites the line
after an edit, moving the version past origin/main's, and a test in
`plot-spec.test.ts` fails while the line and the contents disagree.
`mdx-plot-chart.ts` draws the subtitle, the note and the chart slot,
which it sets to the chart's height (`plotHeight`) before Plot arrives, so
the doc does not move when it does. It fetches Plot and `buildPlot`
from `/app/plot/plot.js` the first time a doc shows one, for KaTeX's reason
below; `plot-entry.ts` is what the build compiles to that path.

`prose-math.ts` joins the same tier and does not move the picture. It is the
grammar of a remark-math equation — `$x$` inline, `$$` … `$$` on lines of
their own — measured against remark-math 6, with two places where it reads
less math (a price like `$5 and $10`, an unclosed fence). The parser holds
inline TeX as a `math` text attribute that is never parsed for emphasis or
escapes, and a display equation as a code block in the `math-display`
language holding its exact lines, the way an `.mdx` component is held, so the
file comes back byte for byte. Four client modules draw it and do not move
the picture either. `math-inline.ts` is the mark and the decorations that
fold the TeX behind a KaTeX widget until the caret reaches it;
`mermaid-code-block.ts` draws the display block. `math-katex.ts` fetches
KaTeX from `/app/katex/` the first time a doc shows an equation, never
before, and fixes its options (`trust: false`, `throwOnError: false`);
`katex-entry.ts` is what the build compiles to that path.
`math-markdown-it.ts` gives tiptap-markdown, which the redline and paste use,
the same boundaries through the same core functions.

`prose-choice.ts` joins the same tier and does not move the picture. A
```` ```choice ```` block is an ordinary code block whose one line names its
options and its pick (`id=… options="yes,maybe,no" picked=maybe`), so the
parser and serializer need nothing new. The client's `choice-block.ts` is
the node view that draws the buttons, and a tap rewrites `picked` in the
block's text, so a pick reaches other pages and the file the way typing does.

`prose-identity.ts`, `prose-outline.ts` and `prose-batch.ts` join that same
document-model tier, and together they are how an agent addresses a block
rather than a region of text. `prose-identity.ts` is the leaf that names the
two attributes a block can carry — its stable id, and the agent that wrote it.
`prose-outline.ts` reads a document as a list of those ids with their headings
and text, and installs the observer that drops the authorship attribute the
moment a person edits the block. `prose-batch.ts` applies a list of scoped
edits in one transaction, refusing to rewrite what the agent no longer owns and
raising a suggestion instead. That suggestion is written by `suggest-blocks.ts`,
which proposes whole blocks rather than a run of text: the target's words
struck, the replacement offered as real blocks beside it under the same sid,
so `suggest-ops.ts` resolves it with no new code and a replacement that is
itself a heading, a list or a fence is accepted as one rather than as
characters. `prose-batch-write.ts` is the writer under the batch: it turns
markdown into elements at a position — growing a list rather than starting a
second one, rewriting one bullet as several, keeping a rewritten block's id —
and knows nothing about ops, outcomes or who owns a block.
`prose-batch-structure.ts` holds what an applied edit must leave
standing around itself: the notes nested under a bullet it replaces, the
editor's trailing blank line kept at the end rather than stranded above an
insert, and a block with no words, which applies directly whoever owns it.
`prose-nest.ts` is one of those edits given a
module of its own: `nest_blocks` MOVES existing list items under a lead bullet
rather than restating them, which is what lets a note-taker regroup a topic
without retyping a point or orphaning the comment threads anchored to it.
`prose-split.ts` is the second, and it is the only insert in the product that
lands anywhere but an END. Every other one appends — to the document, or to
the end of the section it names — so a heading could be written and never
PLACED, and a topic that had swallowed half an hour could not be broken up at
all. `insert_before_block` opens a slot in front of a named block, splitting
its list when the block is in the middle of one, and a heading written there
re-parents every note below it by ARRIVING: an outline reads a block's topic
as the nearest heading above it, so nothing is moved, nothing is retyped, and
every note keeps its words, its id and its comment threads. What it does
disturb is the list it splits, whose tail is carried by the same clone
`prose-nest.ts` uses — so it asks the same ownership question before it does,
and refuses rather than carry a line a person owns. Server-side they are reached through
`doc-outline-ops.ts`, which sits beside `doc-edit-ops.ts` in the services tier
for the reason that module already gives: `doc-edit-ops.ts` was at the
500-line bar, and the outline verbs are a family of their own.
`doc-suggest-ops.ts` joins them on the same terms: the suggestion verbs
(list, propose, accept, reject, resolve-all) moved out of `doc-edit-ops.ts`
because they are the only ones that announce and the only async one, and they
resolve docs through `DocEditOps.live` so a dry run's copy is what they see.

The scoped edit verbs — find_and_replace, rewrite_thread_region, the anchor
inserts and the block deletes — run through `DocEditOps.guardScopedEdit`, the
rule `set_doc_content` already had, narrowed to blocks. `scoped-edit-guard.ts`
holds the pieces: the per-block stamps `live-doc-fanout.ts` takes when a
person's edit arrives over the websocket, the dry run that tries an edit on a
copy of the doc to learn which blocks it would change, and the 409 it returns
when one of them changed after the agent's last read. A doc a person edited in
the last ten minutes is backed up before the first scoped edit after each of
their edits. `block_edits` is not guarded: it already turns an edit to a
person's block into a proposal.

The note-taker is the first caller and deliberately not a privileged one. It
holds no private write path into a document: it reads an outline and posts
block edits through the same `DocStore` verbs the MCP tools expose, which is
why the modules that used to give it one — a section finder, an ownership
ledger, a whole-section merge planner — are gone rather than moved.

## The core flows

```mermaid
flowchart LR
  subgraph f1["A comment: browser → .ydoc → agent"]
    B1[Browser] -->|Yjs update over WS| R1["Live doc<br/>doc-store.ts"]
    R1 -->|debounced persist| Y1[(".ydoc · bound .md")]
    R1 -->|thread event| S1["SSE bus<br/>sse.ts · sse-mux.ts · sse-writer.ts"]
    S1 -->|channel frame| A1["Agent<br/>mcp watch_doc"]
  end
  subgraph f2["A task: MCP tool → board"]
    A2[Agent] -->|tool call| M2[mcp] -->|"REST /workspaces/{id}/tasks"| G2["write gate<br/>owner · shape · deps"]
    G2 --> T2["TaskStore<br/>tasks.ts"] --> J2[("tasks JSON · activity JSONL")]
    T2 -->|SSE| H2[Board tab]
  end
  subgraph f3["A meeting tick"]
    Mic[Browser mic] -->|PCM16| W3["WS /audio/&lt;docId&gt;"] --> Rl[MeetingRelay]
    Rl <-->|turns| En[Transcription engine]
    Rl --> St[("append-only transcript")]
    Rl --> N3["Notes session<br/>pause-or-cadence clock"]
    N3 -->|"Haiku compose · planNotesMerge"| D3[Doc notes section]
  end
```

The file is the source of truth at rest, the live doc at runtime, both
directions debounced — which is why a plain `Write` to a bound file loses: the
doc reasserts itself a second later while git still exits 0. The doc→file
direction is never refused, so a doc emptied in the editor empties its file;
`file-binding.ts` first copies what the file held into the data dir's
`clobber-backups/` (`<docId>-emptied-<ms>.md`) and logs the path, and the
editor offers Undo for the same edit (`mass-delete-undo.ts`). A file change
the doc did not write, landing on un-flushed edits, is a conflict: the file's
version is backed up there too and the live doc is written over it. While one
of our own writes is still on the thread pool, a flush does not read the file
at all and re-arms instead, because the file then holds our bytes under an
mtime not yet recorded, and reading it would back up our own write as an
outside change. A new field needs
three additions, MCP tool schema, route and service, and the route is the one
nothing type-checks, so add an HTTP-level test for every new parameter. The
audio socket is the meeting's lifecycle: every way it can end ends the meeting
exactly once, and nothing word-rate enters the SSE buffer.

**The cross-board review** reads every board at once and writes through none
of its own routes. `cross-review.ts` builds one queue from each board's Home
rows (`home-pane.ts`), sized by `review-sizing.ts` against the rates in core's
`review-size.ts` and ordered project-first by `review-plan.ts` and
`cross-review-queue.ts`. `/review` walks that queue with the board's own
walkthrough card (`workspaces-app/src/reviews/`), and each answer posts to the
board the item lives on. When an answer lands, `review-answer-ledger.ts`
records where it stood in the order last shown and how long it waited, which
is what `/api/review-wait` reads back per board. The landing page's bar and
project list are `landing-review.ts`, with each project's one-line summary
from `board-summary.ts`; the bar counts waiting items per project and needs no
script, so the app's `landing-review-bar.ts` is gone. Choose-difficulty is off
unless a browser turns it on (`review-sizes.ts`); when on, the size a person
picks is kept per signed-in identity by `review-size-prefs.ts` (the browser's
copy is only a cache), and the project
order comes from a hand-edited `review-plan.json` naming the plan board —
there is no route that sets it.

The plan board's lead may rank single items on any board, and the queue puts
ranked items first, lowest rank first, with every unranked item in the order
above (`applyLeadRanks` in `cross-review-queue.ts`). The ranks are kept on the
plan side in `review-ranks.ts` (`review-ranks.json`), not beside each item,
and a person moving a task after the rank voids it. `POST
/api/review-queue/rank` is the one write, open only to that lead with its own
agent token (MCP verb `rank_review_item`). The lead hears what to rank from
`ask-feed.ts`: every new review item on another board, batched over a
10-minute window into one addressed `workspace.new_asks` frame carrying board,
row, key, headline and filing time, never the detail. The feed and the
ranks cover every board, including one that is private or that the coach is
off for: the lead sees what the owner sees (the owner, 2026-10-23), and
the coach's own switch (`coach/exclusion.ts`) applies to the coach alone. A lead stream opened off this
machine (through the tunnel, or from a peer that is not loopback) gets the
frame without the asks from local-only boards and docs (`offBoxAskView`,
which `routes/upgrade-stream.ts` hands both stream kinds as their transform).
The window is `held-window.ts`, which the coach's session feed uses too, and
`lead-rank-wiring.ts` composes the three against the stores.

The same verb also files an item under a goal tag: a plan-board goal id,
`urgent`, `not-this-week` or `drop`. The tag is stored beside the rank and a
person's move voids it the same way. Once any open item carries a tag that
Home can show, the landing bar becomes `landing-goals.ts`. It shows the lead's
Top 10, and then the items by goal: urgent first, the plan's goals in order,
the untagged items under one count line, and not-this-week and drop folded.
Each row opens `/review?item=<key>`. With no tags, the bar is unchanged.

An open landing page stays current. `landing-changes.ts` taps every SSE
broadcast, keeps the task, goal, review-item, decision and thread events, and
sends one `landing.changed` frame per 250ms burst on
`/landing/events:stream` (`routes/landing-stream.ts`). The page's
`landing-live.ts` then re-reads `/` and swaps the review bar and the board
list, keeping the open tab and folds. A lead's rank is broadcast nowhere, so
the rank route calls the feed directly.

**Home across servers.** Bryan's Home on the Mac also lists the review items
on boards that other servers hold. The Mac pulls them and no server calls the
Mac. `home-remotes.ts` reads the board router Worker's own table
(`infra/board-router-worker/`, `BOARD_ORIGINS`) with the Worker's own parser,
and for each board listed under another origin it holds one stream open
through the one address: `GET /workspaces/<board>/home-feed/events:stream`,
with that server's Access service token. Each `landing.changed` frame on it
makes the Mac re-read `GET /workspaces/<board>/home-feed`
(`routes/home-feed.ts`), and a feed that changed tells open Home pages to
redraw through the Mac's own `landing.changed`. `home-feed.ts` is the fixed
schema both ends spell, and the check the Mac runs on every row: named fields
only, each type- and length-checked, a bad row dropped and counted, and a link
kept only when it is a same-origin path to a board the table says that server
holds. `landing-remote.ts` draws the rows as escaped text inside
`#landing-review`, so the page's existing swap redraws them. The feed route
answers above request admission, with its own gate, because a service token's
stamp names nobody (security.md).

**The relay between organizations.** `org-relay/` carries agent messages
between project servers, and runs as a process of its own, not inside the
server: it holds every project's token so that no lead has to. A seat sends by
opening a thread on its outbox doc on its own board, first line `to: <seat>`.
The relay reads each outbox with that server's credentials, so the sender is
the outbox's seat, never a name the message gives. `relay-config.ts` reads a
mode-600 file naming the servers, their organizations and the seats on them;
a seat's organization is its server's. `relay-rule.ts` delivers inside an
organization, refuses across one unless the sender and the recipient both
hold cross-organization access, and runs the fixed checks. `relay-filter.ts` is the Haiku classifier,
on the review judge's model and key path, which every cross-organization or
untrusted message passes; a flag, an error or a timeout holds the message.
`relay.ts` delivers onto the recipient's inbox doc as a quoted subject thread
marked with its source, and `relay-log.ts` keeps the append-only log (no
bodies) and the hold queue that `relay-bin.ts release <id>` empties. Every
call is an existing thread verb (`relay-client.ts`). The relay takes a
thread as the seat's only when the server says the seat's own board token
opened it: `thread-opener-proofs.ts`, top-level in the server beside the doc
store it decorates, keeps that record outside the doc and the thread list
returns it as `openerProof`. It joins the doc-store group and moves no
boundary. Tests: `org-relay-two-servers.test.ts` (two real servers),
`org-relay-units.test.ts`, `org-relay-sender.test.ts`.

**GitHub events for boards on other machines.** GitHub is read once, by the
broker on the Mac (`~/dev/github-claude-channel`, 127.0.0.1:7902, the
owner's token). A board on another server holds no GitHub token: it stores a
subscription list, each entry a repo and the kinds wanted (ci, review,
mention, merge, issue, deploy), and the id of its one live push key
(`github-hub.ts`, `<dataDir>/github-hub.json`). Agents set the list with
`set_github_subscriptions`, from the board's own machine.
`github-relay/` runs on the Mac as a process of its own, like `org-relay/`:
for each configured board it reads the list with the board's push key, holds
one broker session watching those repos, and pushes each matching line
(`routes/github-hub.ts`). It reads the broker's `/state` every pass and
registers again when its session is gone, because the broker answers a poll
for a session it forgot with an empty list. The board checks every push
against its own list again and sends it to each agent holding a stream on it
as one addressed `workspace.github_event` frame, which the MCP child renders
with the text quoted (`github-event-line.ts`). Pages never receive it. Tests:
`github-relay-two-servers.test.ts` (two real servers and a stand-in broker,
restarted), `github-hub-routes.test.ts`, `github-hub.test.ts`,
`github-relay-units.test.ts`.

**Incoming Messages** is a section on the landing page that lists the
message threads an inbox reader agent judged worth Bryan's time. It is not a
board feature. `inbox/` holds the store (`rows.json`, with
the message text kept apart in `bodies.json`, both mode 600, soft delete
only), the per-field checks the reader's rows pass, the rank and the
server-drawn section. `routes/inbox.ts` has two gates that never overlap.
`POST /inbox/rows` is the one write path, open only to the configured
posters, each with its own agent token: the reader, and the agents in
`posterAgentIds` (Job Search posts the recruiter leads it judges worth his
time). The MCP verb for it is `post_inbox_rows` (`mcp/src/tools/inbox.ts`).
A post may also dismiss rows as handled elsewhere, by thread id; the move
is a history entry by `agent`, and the row waits in the removed fold for
Bryan to bring back. A post may name the poster's own scheduled run,
and `inbox/run-close.ts` moves it to done through the task store's
transition, the one place this section touches a board. The body read and Bryan's taps need an owner
person proof from the front page's origin. `landing.ts` in the same folder
draws the section only for that proof. The behaviour is
`workspaces-app/src/landing-inbox.ts`, inside the landing bundle. Nothing
here emits an event of its own, so no row reaches an agent's stream; the run
close emits the ordinary `task.transitioned`, with counts and no row text.
Bryan's Send is `inbox/reply.ts`: it checks the words and the nonce,
rebuilds the destination from the row (`reply-target.ts`), and hands it to
the one transport seam (`send-transport.ts`), behind which `send-gmail.ts`
and `send-slack.ts` read their Keychain credentials (`send-keychain.ts`).
`sends.ts` keeps the ledger the nonce and the hourly limit read. The reply
box is `workspaces-app/src/landing-inbox-reply.ts`, and the snooze picker,
the key list behind `?` and the Undo toast are `landing-inbox-modals.ts`
beside it. Bryan's Remove is a tap like snooze: the row goes to `dismissed`
with no reason, and a new message on its thread reopens it.

**The coach** helps the owner with habits he names, in three parts. It is not a
board feature; the one agent it reaches is its own session.
(A) *Goals*: "Set up my coach" on the front page makes one learning-goals doc
and the session's Coach memory doc on a board of their own (`coach/setup.ts`,
`coach/goals-doc.ts`); the planning interview fills the goals when he taps
Talk. The doc has the coach's name and one section, "What I want to do
better": each top-level bullet or paragraph there is one goal and names its
own trigger. A doc in the older layout, one section of four parts per goal,
still reads, its "Act differently when" joined to each goal. The front
page's section (`coach/section.ts`, `coach/landing.ts`) lists the goals, offers a review when they have not changed in a week, holds the
how-readily setting, and says how many events the session read today.
(B) *Observe*: board and doc pages send what he is looking at, and each
paragraph he writes when he pauses, to `/coach/here`
(`workspaces-app/src/coach-card.ts`); the front page and the review walk,
which name no board, send which page they are (`PAGE_PLACES`); `coach/stream.ts` turns that and his
own comment, reply and open rows (through `onActivity` in `activity.ts`)
into one event per thing he does, dropping repeats. The coach's visibility
is the owner's own: every board he can see, local-only, sharing-locked and
shared ones included, minus the boards he turned off from the card ("Coach
off for this board", `POST /coach/boards`), from which `coach/exclusion.ts`
drops everything (the owner, 2026-10-28: "All boards. Team Lead and Coach may
have access to everything I have access to."). A doc on a board he turned off
is off wherever it is viewed, and when the boards holding a doc cannot be read
it counts as off. What reaches the coach from a shared board is only his own
actions there.
(C) *Intervene*: `coach/moment.ts` sends every event, his answers and his
how-readily setting to the coach's Claude Code session, the Coach board's
lead, as addressed frames (`coach/session-feed.ts`). Events are held: the
first opens a 15-minute window, which then goes as one digest
(`coach/digest.ts`: a run of views is a place and its minutes, and what he
wrote, commented or replied keeps its words). Each digest also carries the
plan board's goals in board order with the day the list was last set, marked
possibly stale past eight days, or says there is no current week plan
(`coach/week-plan.ts`). It also lists his Claude Code time per attached session, the repo and its
active minutes, counted from each prompt he typed (the plugin's
UserPromptSubmit hook posts typed-or-not, and a typed prompt's reduced text,
to `routes/prompt-marks.ts`) through the turn notes and injected prompts after
it, each crediting the gap since the session's previous mark, capped, never
for the coach (`coach/session-minutes.ts`). Haiku says each prompt and turn
in a line, 40 marks a call (`coach/summary.ts`); the text stays on the
server. A hook in a session launched with no board posts to the one board
where that session holds a stream (`plugin/hooks/lib/joined-board.ts`), and a
`claude -p` or SDK run counts as nobody typing. A typed prompt opens a window as
a board event does, and so does any mark in his run after it; a mark outside a
run never does. `coach/coverage.ts` counts, per hour, what he sent by source
(desktop, iPad, phone, Remote Control, terminal), what the coach let go and
why, and what the digests carried, for the loopback `GET /coach/coverage`. A quiet stretch sends nothing,
and answers and the setting go at once. With no session holding a stream
the windows wait in `coach/backlog.json` (`coach/backlog.ts`, bounded to 96
windows and 48 hours, across a restart) and go as one digest when its stream
comes back. Past 400 turns in a day it sends
nothing and the front page says the coach is paused for today. The session raises a moment on `POST /coach/moments`, and
`coach/judge.ts` refuses one that does not copy three words in order from the
goal it names, or arrives while another is open. A moment goes to his pages over
`/coach/stream` (`coach/hub.ts`) and follows him: every page he has open
shows it until he answers in any one, which clears it on the rest. That is
the board (task pages included), every doc surface (`doc/doc-coach.ts`,
mounted for markdown, folder files, diffs and code alike), the front page,
and the host page around a mock or dev server (`coach-page.ts`, its own
`/app/coach.js`, since the sandboxed frame cannot draw it). A page on a
board that is off for the coach shows it too, marked so, and tells the
session nothing. He answers with a thumbs up, or a thumbs down with a few
words of why that reach the session in `coach.answer`. In the session, `mcp/src/coach-line.ts` renders each frame and
`coach_moment` raises a moment; the persona is the plugin's `coaching` skill.
With no session holding a stream the front page says it is offline, and
only the digests wait for it. `coach/store.ts` keeps it all in `coach/state.json`, mode 600;
`coach/wiring.ts` composes it for `server.ts`. `scripts/coach-eval.ts` plays
the fixture days to a real coach session and scores it.

**How long an item waited to be READ** is two rows on the board's own event
log, and nothing else: `review_item.viewed` when somebody's client first puts
an item on screen, `review_item.answered` when an answer lands on it. Both are
built in `server/src/review-items/analytics.ts` and nowhere else, so
"ids and timestamps only, never the ask and never the answer" is a property of
one function rather than a rule six emit sites remember; they land in
`<dataDir>/workspaces/<ws>.events.jsonl` beside every other board event, and
`workspace-next.ts` strips them from the Activity feed the way it strips ticks.
The browser half is `workspaces-app/src/review-item-seen.ts` — one
`IntersectionObserver` and one per-page ledger shared by the three surfaces
that show an item (the walk card, the task panel's card, a doc thread's card),
so meeting the same ask twice in one page load is one row. Neither adds a
subsystem: the server module joins the review-item family under `routes/`, and
the client module is chrome-free measurement with no UI of its own.

## Subsystem docs

- [meeting-assistant.md](meeting-assistant.md) — live transcription and notes on a pause-or-cadence clock.
- [stall-check/](stall-check/README.md) — the stall check's design, what "working" means, and per-module criteria; [stall-detection.md](stall-detection.md) is the mechanics as they run today and why each layer exists.
- [goal-projection.md](goal-projection.md) — the goal bar, the remainder, and when a goal lands.
- [supervisor.md](supervisor.md) — the health check `scripts/serve.ts` runs against the server it supervises: what the probe asks, why the budget is 75s and a first bind's is 240s, the three-per-hour restart limit and its on-disk ledger, and the 16 September 2026 outage as the worked example. It adds no module to the picture — `supervisor-health.ts`, `server-starts.ts` and `event-loop.ts` are already drawn in Ops — but the budgets and the restart limit were stated nowhere a reader could find them, and the 75s was being read as 45s.
- [stall-detection.md](stall-detection.md) — gains two top-level modules and no new shape. `waiting-unfiled.ts` is pure: given a task's notes and the board's owner names it says which note the stall clock may read, so it sits in the domain tier beside `keep-moving.ts` and `stall-gate.ts` and calls `detectAsk` rather than reading prose itself. `waiting-unfiled-escalation.ts` is the aging half, a sibling of `stall-escalation.ts` in the same keep-moving box, sharing its `TeamLeadReach` and its filing actor; `stall-nudge.ts` calls it once per tick with the boards it has just read. Neither adds an edge the picture did not already draw. `waiting-unfiled-review.ts` was later split off the escalation — the words on its fleet-wide item, plus the `AgingWait` shape that is their input — and adds no edge either: it is pure, sits in the domain tier beside `waiting-unfiled.ts`, and has exactly one importer. `waiting-unfiled-sidecar.ts` was split off the same file for the other reason: it is the persistence half, and while it sat inside the escalation there was no test anywhere that read or wrote the file — which left "an old sidecar still escalates, and a restart does not re-gift a row its spent wakes" as a comment rather than a case. Both splits are the seam `exceptions.md` already names as the obvious cut on `stall-escalation.ts`, taken here because the escalation stood at 498 lines and the fleet-wake cap would have pushed it past the bar.
- [stall-detection.md](stall-detection.md) — gains one more top-level module, `owner-ask.ts`, and no new edge. It is the reading `keep-moving.ts` used to fold into its bucket branch: given whether an open item is filed, whether the board says a person owns the row, whether the row is in the backlog, and — since 2026-09-17 — the date of the row's own schedule rule, it says whether a person is owed an answer and whether the ask is where they read it. The fourth fact is there because splitting the two questions made every reading reachable for a rule row, a future-dated one included, and a row deferred to January owes nobody an answer today. Pure, so it joins the domain tier beside `keep-moving.ts`; `keep-moving.ts` is its only caller and re-exports `FiledItemAddress` and `ReviewItemRow` from it, so no other module's imports moved. It exists apart because whether a row is dispatchable and whether it carries an unanswered question are two questions, and deciding both in one branch is how a schedule rule swallowed a comment.
- [stall-detection.md](stall-detection.md) — gains one more top-level module, `blockage-lift.ts`, and no new edge. It is the reading behind the `unresumed` finding: given a task's answered asks and its done-when lines it says WHEN the blockage lifted, and given the classifier's own quiet reading it says whether anything has happened since. Pure — no clock, no store — so it joins the domain tier beside `keep-moving.ts` and `ui-review-gate.ts`, and it is wired exactly where `noteClocks` is: `stall-wiring.ts` reads both answer surfaces on the walk it already makes over each row's review state and hands `evaluateStalls` a map, so `stall-gate.ts` gains an optional input rather than a store. The finding rides the existing stall frame and the existing verdict line; nothing new reaches the board's owner.
- [stall-detection.md](stall-detection.md) — gains one more top-level module, `unanswered-thread.ts`, and no new edge. It is the other DIRECTION of the same question. `review-queue.ts` walks every open thread for an agent's unanswered comment and for a declaration awaiting a person, and both of those runs end at a person — `unansweredRun` breaks at the first author who is not an agent — so a thread whose last speaker is Bryan produces no row anywhere, on a doc that may hang on no task at all. This module is the predicate for that case and the row the wake names: pure, so it joins the domain tier beside `stall-gate.ts`, reading only `classifyActor` from `actor-identity.ts`. `stall-wiring.ts` calls it once per board tick over `workspace.docIds` — the same walk `heldThreadReviewItems` already pays for — and the row rides the existing stall frame to the board's LEAD. It never reaches the board's owner: the escalation that goes past a lead anchors on `stalled`/`unfiled` rows, and a waiting thread is neither, so a question Bryan asked can never be filed back onto Bryan's own queue.
- [unfiled-ask.md](unfiled-ask.md) — the two top-level modules `unfiled-ask.ts` and `unfiled-ask-filing.ts`, which judge whether a closing message asked the board's owner something with nothing filed. They join the services tier beside `chat-audit.ts` and move nothing in the picture: one is pure text, the other one walk of the task store, and only `routes/dispatch-and-notes.ts` calls either. The doc carries the measured false-positive and false-negative rates, because the count they feed is unreadable without them.
- [unfiled-ask.md](unfiled-ask.md) — also gains `agent-note-log.ts`, one more top-level module in the services tier and no new edge. It is the durable half of `agent-notes.ts`'s per-agent ring: a board where one session holds several in-progress rows can place none of its end-of-turn notes, and the ring they fell back to is in-process, twenty deep and read by nothing, so every one of them was dropped. The log appends each unplaced note to `<dataDir>/workspaces/<ws>.agent-notes.jsonl` — its own file rather than a new `TaskStoreEvent`, because a store event is a change to the board and an unplaced note is a record about an agent, and because every consumer of `events.jsonl` keeps an exclusion list that a new type would have to be added to. `routes/dispatch-and-notes.ts` is its only caller, writing on the POST and merging it into the GET.
- [stall-detection.md](stall-detection.md) — gains two top-level modules,
  `waiting-unfiled-frame.ts` and `waiting-unfiled-filing.ts`, and no new edge.
  The second is the per-board half of the unfiled-ask escalation — which board
  gets an item, which board's is revised, which board's is taken back — split
  out when the item went from one for the whole server to one per board and
  the file reached the 500-line bar. It is NOT pure: it holds a store and
  mutates a sidecar, so it joins the services tier beside
  `waiting-unfiled-escalation.ts`, which remains its only importer. The split
  is worth its file because these are the calls a person's queue actually
  sees, and driving them needed a tick, a clock and a Team Lead until they
  moved out. The first: It is the ONE fleet frame Team
  Lead is woken with about unfiled waits, split out of
  `waiting-unfiled-escalation.ts` on the seam that file's two earlier splits
  used: rendering is a pure function of the due rows, so what a reader gets
  can be driven without a reach to send it through. It is pure, so it joins
  the domain tier beside `waiting-unfiled-review.ts`, and its one importer is
  the escalation that already sat in the keep-moving box. Same PR retires
  `stall-frame-news.ts`'s `withoutPersonBlocked` — a filter, not a module, so
  the picture is unchanged there.
- [stall-detection.md](stall-detection.md) — gains three top-level modules and no new edge, all three answering ONE question: does this frame tell its reader anything it does not already have? A week of the fleet's transcripts put repeat or empty reminders at 11% of all model spend, and a wake is the reader's whole turn. `wake-sent-sets.ts` is the memory — per board, per session, the tokens of the last frame actually delivered, persisted beside the armed stamps so a deploy does not re-send what the previous process sent; both nudgers own one. `stall-frame-news.ts` is the three readings the stall wake takes of a built frame: the tokens the stamp does not already carry, whether every task the frame would name moved inside the moved-within window, and the person-blocked rows that come off the board before the lead is woken at all. `waiting-unfiled-routing.ts` is which rung of the unfiled-ask ladder a row belongs on, split out of `waiting-unfiled-escalation.ts` when the two buckets stopped sharing an addressee. All three are pure — no clock, no store, no socket — so they join the domain tier beside `stall-gate.ts`, and their callers are the two nudgers and the escalation that already sat in the keep-moving box.
- [app-voice.md](app-voice.md) — how a sandboxed mock or app proves it is one doc on one board, and the socket that lets it speak, listen and write to its dev server. It adds `core/app-voice.ts`, `widget/src/app-voice/` and `server/src/app-voice/`, drawn beside the spoken reply above.
- [security.md](security.md) — the boundaries, and which gate decides each one.
- [routes.md](routes.md) — every front-door path pattern and the gate it sits behind, generated from `routes/route-table-rows.ts`.
- [glossary.md](glossary.md) — the nouns, once each; [exceptions.md](exceptions.md) — every file over 500 lines, split or excepted, with [split-plan.md](split-plan.md) as its queue.

`meeting-home.ts` is the one new top-level module in the Meetings box, and it
holds the two facts a meeting needs before anybody speaks: which folder of its
project it files into, and how much of it that project chose to keep. The
choice sits on the `ProjectRecord` the mount registry already keeps per
project, beside privacy and the conventions path, because it is the same kind
of thing — something the project decided and this server applies. The filing
record beside it is one append-only line per meeting saying which board,
project and lead seat the conversation belonged to, folded on read like
`meetings.jsonl` next door. Retention is expressed as what is never WRITTEN,
so nothing here deletes; `meetings.ts` asks it once at start and carries the
answer on the meeting. `routes/mounts.ts` is the lead's door to the choice and
`routes/doc-title.ts` is the fourth member of the docs chain, which is where a
person renames the meeting the clock named. On the client `doc/doc-rename.ts`
joins the existing `doc/` family in the view tier and adds no box: it makes
the topbar title its own editor.

## Adding a file

1. Name its layer first. If you cannot, it is doing two jobs.
2. Check the import direction. A service importing a route, or a model
   importing the DOM, is the error the layers exist to catch.
3. Keep it under 500 lines, or add a row to `exceptions.md` saying why —
   `bun run loc:audit` fails a file that crosses the line with no row.
4. If it is a **top-level** module — a file or directory sitting directly in
   `packages/<pkg>/src/` — redraw the diagram above in the same PR.
   `bun run check:architecture` fails a PR that moves that map without it.
5. In `server`, if it names a URL path it goes under `routes/`; if it runs for
   every request whatever the path, or never sees a `Request`, it stays at the
   top level. The rule and its two consequences are
   [.claude/rules/code-health.md](../../.claude/rules/code-health.md), "A route
   lives in `routes/`", and `bun run check:imports` fails the import edges it
   forbids.
