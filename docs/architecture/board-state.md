# Board state: the task store, its Yjs mirror and compaction

How board state is owned by the server and mirrored to Yjs, what a projected task carries, page load reporting, how an edit re-projects rows, "Done when", and doc compaction.

> Moved out of [overview.md](overview.md) on 2026-11-24, when the overview was cut to a map. "The diagram" and "the picture" below mean the package diagram there.

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
from `widget/src/mock-host.ts`). A file switch inside an open diff loads no
page, so each one reports for itself as the page type `diff-switch`, timed from
the click to the next file on screen. A page on a board posts to that board's
`/workspaces/:ws/load-reports`; Home and `/review` post to `/api/load-reports`
(`routes/load-reports.ts`). `slow-load-alarm.ts` judges every report against
2,000 ms, raises through Sentry once per page type per board per five minutes,
and `page-loads.ts` keeps one server-wide log that
`GET /api/load-reports/slowest` reads back as the slowest load per page type
over 24 h for the daily health check. `spend-alarm.ts` is the other alarm
in that group: it sums the day's priced usage rows from the meeting calls
(`meeting-notes.ts` records each into it) and raises one Sentry warning the
day they pass `CW_SPEND_ALARM_USD`, so a project server, which is one org,
says when its org spends too much. A report from a page that was hidden
before it was sent carries `hidden: true` and is counted but never judged:
a hidden tab paints nothing and its clock keeps running. Each report also
carries the navigation's `msToResponseStart` / `msToResponseEnd`, so a slow
one says whether its time went to the request or to the page. These reports are the only record of
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
