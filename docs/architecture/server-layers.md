# Layers inside `server`: the full table and where each module sits

The full layer table for `packages/server/src`, and the notes on modules that joined a layer without changing the picture. The short form of the rule is in [overview.md](overview.md).

> Moved out of [overview.md](overview.md) on 2026-11-24, when the overview was cut to a map. "The diagram" and "the picture" below mean the package diagram there.

**Imports point downward only** — a file may import its own layer and every layer below it, never one above.

| Layer | Where it lives | Why it is its own layer |
| --- | --- | --- |
| **HTTP** | `server.ts`, `routes/**`, `middleware/**`, `shells.ts`, `request-admission.ts`, `request-attribution.ts`, `socket-handlers.ts`, `board-sockets.ts` | The only code that knows about HTTP. Parse, admit, call one service, format. |
| **Services / stores** | `doc-store.ts`, `tasks.ts` and the `task-*` stores, `review-items/**`, `home-pane.ts`, `share/**`, `sharing-notice.ts`, `sharing-off-door.ts`, `auth/**`, the `meeting-*` and `notes-*` families, `sse.ts`, `activity.ts`, `permission-grants.ts` | Owns durable state and orchestrates one change across stores and adapters. |
| **Domain (pure)** | `task-owner.ts`, `task-fields.ts`, `task-row.ts`, `decision-shape.ts`, `safe-path.ts`, `workspace-path.ts`, `board-links.ts`, `path-params.ts`, `diff-groups.ts`, `pause-ticker.ts`, `keep-moving.ts`, `owner-ask.ts`, `stall-gate.ts`, `unanswered-thread.ts`, `waiting-unfiled.ts`, `waiting-unfiled-review.ts`, `waiting-unfiled-frame.ts`, `ui-review-gate.ts`, `blockage-lift.ts`, `notes-edit-parse.ts`, `notes-prompt-build.ts`, `notes-prompt-cache-shape.ts`, `notes-invented-links.ts`, `notes-scheme-links.ts`, `notes-research-placeholder.ts`, `ask-detection.ts`, `notes-link-intent.ts`, `notes-idea-coverage.ts`, `notes-missed-words.ts`, `notes-recent-speech.ts`, `notes-edit-guard.ts`, `notes-edit-bullets.ts`, `notes-pending-clauses.ts`, `notes-edit-correction.ts`, `notes-section-fit.ts`, `notes-heading-level.ts`, `notes-heading-rename.ts`, `notes-dictation.ts`, `notes-reason-ask.ts`, `notes-inversions.ts`, `notes-unconfirmed.ts`, `notes-method.ts` (core), `notes-cleanup-report.ts` (core), `model-quota.ts`, `notes-notice.ts`, `notes-edit-address.ts`, `dispatch-request-event.ts`, `agent-listening.ts`, `claude-key-source.ts`, `project-profile.ts` | Functions over values: no clock, filesystem or socket unless passed in, so a rule is testable without a server. |
| **Adapters** | `transcribe-*.ts`, `recall*.ts`, `google-oauth.ts`, `summarize.ts`, `deploy*.ts`, `client-release.ts`, `push-notify.ts`, `share/cf-api.ts`, `share/keychain.ts`, `secret-store.ts`, `settings-allow-file.ts`, `git-diff.ts`, `sentry.ts`, `outbound-fetch.ts` | One vendor or OS facility each, behind an injected interface, so a swap or a test double touches one file and no state. |
| *Composition root* | `bin.ts`, `server-config.ts`, `server-deps.ts`, `start-contract.ts` | Reads the environment once, builds adapters, wires services. Beside the stack, not on top of it. `start-contract.ts` is the supervisor's half: the port, the data dir (required, no default) and whether a busy port is waited for (prod) or refuses the start; no start moves to another port. |

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
`library-folders.ts` sits beside them as well: the board's own folders for
its docs, kept on the board record (`tasks.ts` persists them) and never on
disk, so filing a doc moves no file and changes no doc id. It holds the
rules — a duplicate name in one place is refused, the built-in Meetings
folder holds every meeting nobody filed and cannot be moved or archived, an
archived folder is a reversible mark — and `routes/workspace-library-folders.ts`
answers them; a change fans out as the board's `library.changed` frame. The
MCP verbs over those routes are `packages/mcp/src/folder-schemas.ts` and
`tools/folders.ts`. `library-lister.ts` is the project-markdown lister split
out of `library.ts` for size; it changes none of the picture.
`library-views.ts` keeps each person's Recently Viewed list on the same board
record: a doc id and a time per view, never text. Only a browser's request
whose author reads as a person is recorded, so an agent's read never lands
there; `routes/workspace-library-views.ts` takes the page's
`POST library/views`, and the client's `library-view.ts` sends it when a doc,
mock or whiteboard page opens.
`library-stars.ts` keeps each person's Starred list beside it, under the
same two checks: board items and folders by id, never text. The same route
module answers `library/stars`; the Library rows and the top bars of the doc,
whiteboard and mock pages (`doc-star.ts` in the client) carry the toggle.
`library-sets.ts` folds a diff review's files back into the one item it is
filed on the board as, its review id, so the Library lists, stars and records
a view of the review as one row that opens its entry page; a diff file's page
answers with that id (`libraryIdOf` in the client's `library-view.ts`).
`doc-move.ts` joins the Doc store box under its `doc-*.ts` glob and changes
none of the picture: the migration verb that moves a board doc from the
server's storage into a mounted or meetings folder of the board's project. It
writes the file, rebinds the doc through `file-binding.ts`, claims the file's
address in `repo-registry.ts` so the Library above reads it as one document,
and moves a meeting's filing record with it. `routes/doc-move.ts` answers it.
`doc-file-relocate.ts` joins the same box under the same glob and changes
none of the picture either: `move_doc_file`, which renames a bound doc's file
inside its repository, or points the doc at a file `git mv` already moved.
It flushes the doc, renames, rebinds through `file-binding.ts` keeping the
old binding's write-back record, and aliases the address in
`repo-registry.ts`. `routes/doc-file-move.ts` answers it.

`transcribe-soniox-tokens.ts` is the Soniox adapter's token reading (speaker
letters, a turn's language from its words' tags), split out of
`transcribe-soniox.ts` and covered by the same `transcribe-*.ts` glob.

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

On a project machine the board's lead agent is a Claude Code session beside
the server, not part of it (`infra/project-machine/lead.sh`). It reaches the
server through its board's unix socket (`CW_BOARD_SOCKET`), as a walled lead
on the Mac does, and runs as a user of its own, so it holds none of the
server's credentials and the server holds none of its.
`middleware/loopback-uid-door.ts` joins the HTTP row and moves no boundary:
it refuses loopback TCP from that user, by uid, at the front door. The runbook is
[docs/process/project-machine.md](../process/project-machine.md). Which Claude
account a lead runs on comes from the Mac's central token list
(`infra/project-machine/token-list.ts`); `machine:tokens` moves a project
between listed tokens, reads each one's usage, and copies each lead's token
counts per turn into `~/.claude/projects` for the fleet's budget watch
(`machine-burn.ts`). None of it is in a package.

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

`board-links.ts` joins the same row for the same reason. It holds the one
spelling of a review item's link (`home?item=<key>`), which the add and revise
routes return, and the rule that picks which doc on a board a relative link
names. `routes/board-links.ts` is its HTTP reader: it redirects
`review/<id>`, an escaped `home%3Fitem…` and `open?path=` to the page they
meant. No layer changes.
