# Files over 500 lines

The bar: **every file over 500 lines has either been broken up, or has an
explicit exception written here.** This page is the record of that decision, one
row per file. `bun run loc:audit` fails when a file crosses the limit without a
row, when a file has moved more than 20% from the count its row gives, or when
a row's verdict and reason run past 100 words, and CI runs it alongside the
other gates. A longer argument goes in
[exceptions-history.md](exceptions-history.md), and the row links it. Every count was re-measured on
2026-10-17, when 184 of 215 rows were off.

A `Split` verdict names a seam — which functions become which new file — and is
work that is queued, not done. The audit does not enforce verdicts, only that
every oversized file has one: a listed `Split` passes. The point of the gate is
that a **new** god file cannot appear with nobody writing down why.

Regenerate the raw list with:

```bash
find packages \( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' -o -name '*.css' \) \
  -not -path '*/node_modules/*' -not -path '*/dist/*' \
  | xargs wc -l | awk '$1>500' | sort -rn
```

Audited 2026-09-02 at `3a39db67`, and re-counted 2026-09-03 with the command
above: **161 files** over 500 lines, 68 source and 93 test. (The count written
here on 2026-09-02 said 164/70/94; two of that difference predates this
re-count and is not attributable to a listed split.) A7 took `activity.ts`
(582 → 301) and `recall-calendar.ts` (721 → 470) off this list, and A8 took
`voice-smooth.test.ts` (729 → 493); all three rows are gone rather than marked
done. B5 took `prose.ts` (2847 → 83) and `goal-effort.ts` (1086 → 333) off it
the same way, and added three rows for the files that came out of `prose.ts`.
B6 shrank `mcp.ts` 5,563 → 1,426, which cleared the seam its row named without
clearing the bar; the coverage extraction then took it to 400 and its row is
gone rather than marked done. Neither of the two rounds put a new file over the
limit: the eight modules lifted out of `mcp.ts` for coverage are 89–459 lines
and none needs a row.

Two rows were added on 2026-09-03, taking the list to **163**, when the app's
stylesheet tests stopped grepping `styles.css` and started installing it. A
rule that used to be one `toMatch` line became a mount, a viewport and a
computed read, so `md-composer.test.ts` and `board-mic-dock-css.test.ts` crossed
the line without gaining a second subject.

One more was added later on 2026-09-03 for `share-link-flow.test.ts`, the new
share-link route suite. It is a first draft over the limit rather than a file
that grew into it: the flow it drives needs two Access audiences and two
hostnames configured on one server, and every question worth asking about a
share link is a question about that one fixture.

A10 then split `doc-store.ts` (4801 → 3490, and 3527 once the share-link work
landed 37 lines of websocket context in it) and added one row for
`file-binding.ts` (1652), the seam the `doc-store.ts` row had named. A split that
lifts an oversized subject out of an oversized file adds to this list rather
than shortening it — what changes is that each row now describes one thing.

A11 split `board-app.ts` (2592 → 2166) into three modules that are each under
the limit — `board-shell.ts` (193), `board-settings-panel.ts` (181) and
`board-walkthrough.ts` (271) — so this one shortens the list by nothing and
lengthens it by nothing. That is the shape to expect from a file whose
remaining mass is a render closure: what comes out is the pieces that did not
need it, and the row that stays gets shorter rather than disappearing.

A12 then took `server.ts` from 7531 to 5934 across seven modules, of which
only one — `review-gate.ts` (783) — is over the limit and gains a row. The
other six are 133–366 lines and need none. The lesson worth keeping is in the
row this slice was working from: it named `server-deps.ts` as the file to
create, and `server-deps.ts` already existed, doing the OTHER half of the
composition root (the adapters `bin.ts` builds to talk out). A verdict written
months ago is a hypothesis about the code, not a description of it — check the
seam before you cut it.

A13 then took `board-app.ts` from 2166 to 792, by doing the thing A11's row said
was not worth doing. A11 called the render closure one subject because every
`render*` shared one `state`, and read the detail panel's thirty-plus deps as
proof that the seam was the whole closure passed as an argument. That reading
was wrong in one specific way: a long dependency list is not the same as an
implicit one. Written out, `BoardDetailDeps` is the panel's whole reach — it is
long because the panel is where a ticket's every verb is, and what the list
buys is that the panel can no longer touch anything absent from it. Twelve
modules came out on that principle (`board-islands`, `board-projection`,
`board-region`, `board-queue-open`, `board-home-region`, `board-discussion`,
`board-detail-panel`, `board-chrome-region`, `board-data-loads`, `board-load-report`,
`board-deep-links`, `board-voice`, plus `wireNavCollapse` into `board-shell.ts` and
`wireBoardShortcuts` into `board-shortcuts.ts`); only one of them —
`board-detail-panel` (572) — is over the limit and gains a row, so the list
grows by one while the row it leaves behind describes a boot sequence rather
than a render layer. The lesson to keep: **"they all share one `state`"
argues for one PROJECTION, not for one file.** A region that takes
that projection plus a named deps object is smaller than the closure it came
from AND says what it may reach, which the closure never did.

A14 then took `server.ts` from 5934 to 5358, moving the stall / ready-work
wiring out whole to `stall-wiring.ts` (935, and over the limit, so the list
grows by one). The 754 lines that moved are byte-identical to what left apart
from six edits, all named in the PR: five `opts.` reads that became context
fields and one `let` assignment that became a returned `const`. The lesson to
keep is about the ordering the A12 row flagged: `boardsForDoc` really is
built below this block, and so are `backTargetFor` and `reviseCallFor` — and
none of that mattered, because every one of them is called from a request or
an event rather than during composition. **A declaration-order problem that
only exists at call time is a THUNK, not a reordering.** Hoisting the review
gate to satisfy it would have traded this constraint for a worse one: the gate
sits where it does because it needs `resolveWorkspaceForDoc` and the task
projection.

`app.ts` then came off the list entirely (1569 → 484). Its row named the seam
as "a sequence rather than a set of jobs", which was true of the ORDER and not
of the work: each step of that order — the balloon margin, the two floats, the
selection pills, the spin-off runner, the sidebar, the save-state chip, the
write gates — turned out to take a handful of named arguments rather than the
whole closure. Nine modules under `src/doc/`, none over 500, so this one
shortens the list by one and lengthens it by nothing. What is left in `app.ts`
is the sequence that calls them, plus the forward refs the editor's callbacks
need and the reads of the address the mount was opened at.
Test files are judged by a narrower rule, in their own table below: a long test
file is an exception unless two *unrelated harnesses* share it. Many `describe`
blocks over one set of fixtures is one harness, however long the file gets.

---

## packages/server

| File | Lines | Verdict | Reason / seam |
|---|---|---|---|
| `packages/server/src/bin.ts` | 560 | Exception | The process entry: read the config `server-config.ts` resolved, build the adapters `server-deps.ts` makes, hand both to `createServer`, and retry the bind. Most of its length is that one `createServer` call naming each option once, which is a list rather than logic; the config and the adapters are already out. It crossed 500 when the board socket flag joined the list. **Revisit** if it gains a step that is not wiring. |
| `packages/server/src/server.ts` | 4126 | Keep | **The verdict is now Keep, and this is where the program stops.** The largest section is the COMPOSITION ROOT, which is supposed to be long and flat — it names every collaborator exactly once, and splitting it buys indirection without reducing what a reader must hold at once. And `route()` is now a dispatcher. Revisit only if a NEW subject grows inside `route()` — the test is whether something in here has its own reason to change, not whether the line count went back up. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcserverts). |
| `packages/server/src/board-membership.ts` | 917 | Exception | The doc↔board membership map, out of `createServer` in A15. One file because it is one question asked from four directions, and the two that look most separable are the two that must not be: the coverage readout (`watchCoverageFor`) reports gaps against exactly the board set `boardsForDoc` fans events over, and the whole incident it exists to end is a probe answering "covered" about a board the events never reach. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcboard-membershipts). |
| `packages/server/src/request-admission.ts` | 1146 | Exception | The request-admission run, out of the top of `fetch` in A17: may this request reach this server at all, and as whom. One file because the pieces are one decision read at three depths — the host gate classifies, the auth branch its decision selects proves an email, and the scoping turns that into a `visitor` — and each depth is only correct in terms of the one above it. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcrequest-admissionts). |
| `packages/server/src/routes/shell-static.ts` | 763 | Exception | Shell and static serving, out of `createServer` in A18: which page or asset an address gets. One file because it is one decision read at two depths, and the tempting cut — helpers here, routes there — is what would break it. **M**, if the static roots are worth separating from the rendered shells; the case against is that their containment checks are the file's security surface. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcroutesshell-staticts). |
| `packages/server/src/fs-scan.ts` | 520 | Exception | How a folder is listed: `git ls-files` for a work tree, a readdir for a plain folder, and the floor both answers pass. It sat at exactly 500 when the listing cache needed to know which of the two answered last, so it keeps warm only roots git listed (a readdir with no request behind it is the read a cloud-sync folder can hold), and a walled lead's root, whose rescan runs contained git. **Split** the repository probe (`repoKindOf`, `repoKindSync`, `repoKindAsync`, the listed-by-git record, about 70 lines) into its own file when the next line arrives. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcfs-scants). |
| `packages/server/src/routes/upgrade-stream.ts` | 833 | Exception | A19's slice, and the canonical-routes cutover pushed it over the line. Six blocks answering one question — this request wants a long-lived connection rather than a response, so which one, and stamped with what so revocation can find and close it later. The split that suggests itself, upgrades in one file and streams in another, is the wrong one: both halves are authorized ONCE at the handshake. **Keep** unless a seventh block arrives with a different question. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcroutesupgrade-streamts). |
| `packages/server/src/tree-fs.ts` | 504 | Split | Every contained call on a walled lead's folder: the open with no link, the judge, the read, list, mkdir and write. One file because each call is written in terms of `openDir`, `judge` and `rootDev`, and an exported version of those would let a caller skip the judge. The lead-tree work moved the new calls (`existsTree`, `createTree`) to `tree-fs-create.ts`, which reaches the shared pieces through `treeInternals`; `check:tree-fs` refuses any other module that names it. The seam left is the writes (`writeTreeSync`, `writeTree` and the temp-name seam, about 90 lines), which can follow the same way. **S** |
| `packages/server/src/stall-wiring.ts` | 1638 | Exception | The stall / ready-work wiring, out of `createServer` in A14. One file because it is one reading: every member answers "is this board moving, and who has to be told", and the two snapshots exist only to be handed to the two nudgers that share the tick. **M**, if the comment-queue bridge (`onLiveDocEvent`, `queueCommentRows`, `markCommentRowsEmitted`, `commentAuthorIs` — roughly 140 lines) is worth its own file: it is the one member that is a delivery path rather than a reading of the board, and it came along because the stall loop is its only other reader. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcstall-wiringts). |
| `packages/server/src/review-gate.ts` | 1452 | Exception | The review-item quality gate, out of `createServer` in A12. One file because "judged, then announced, in that order" is the rule the whole family exists to keep: a declaration filed on a TICKET and one filed on a COMMENT land in the same reader's queue, so both run the same judge, and a push whose title is the item's headline must never go out for an item that queue omits. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcreview-gatets). |
| `packages/server/src/routes/docs.ts` | 676 | Exception | The `handleDocResourceRoutes` seam this row used to describe is done: the `/workspaces/:workspaceId/docs/:docId/...` resource block split along `rest ===` families into `doc-resource.ts`, `doc-threads-routes.ts` and `doc-edit-routes.ts`, verified byte-identical and in-order the same way A1 verified the whole-file move. **Split** if a third entry point arrives: the create/list pair and the promote route share nothing but this file. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcroutesdocsts). |
| `packages/server/src/routes/doc-threads-routes.ts` | 1118 | Exception | Thread creation (`threads` POST, `threads/by_find` POST) and every per-thread mutation (`threads/:threadId/...` — reply, answer, revise, withdraw, resolve, reopen, reanchor, the anchored-edit trio), plus `reviewFromBody`, the declaration checker all three route groups call and nowhere else does. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcroutesdoc-threads-routests). |
| `packages/server/src/shells.ts` | 1296 | Exception | One job: the HTML this server renders before any bundle runs. Every shell is a complete document with its own `<style>`, which is the point — nothing here may depend on an asset that has not loaded. Splitting per page would separate each shell from the `escape` / `landingShell` / `HTML_SHELL_HEADERS` trio all five share, and the file has no logic to test apart from the strings. |
| `packages/server/src/routes/auth-share.ts` | 1160 | Exception | Two families that look separable and are not: the share routes' refusals are stated in terms of the session the auth routes mint, and the order between them is behaviour (the browser-write refusal sits above every share route so a mint added later is covered by construction). A split would need the boundary written down in two headers instead of one, and the chain position asserted twice. |
| `packages/server/src/routes/meetings-calendar.ts` | 786 | Exception | Just over the line, and one chain position: every `/workspaces/<ws>/docs/<id>/meetings...` pattern must be tried before the doc catch-all. Splitting meetings from calendar would make that one ordering constraint span two files for 62 lines of relief. |
| `packages/server/src/spoken-reply/session.ts` | 920 | Split | One spoken-reply socket: the page's messages, the listener, the voice, and the turn counter every one of them checks. It crossed the line when the voice review queue added the `decided` message — the page reporting whether a recorded answer landed — and the ten-line path that says a failed one aloud. **S** Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcspoken-replysessionts). |
| `packages/server/src/route-table-rows.ts` | 849 | Exception | A registry, not logic: one array literal, one row per route, read by `routes:table` and by the host guard, whose share allowlist is built from its share-visible rows. It crossed the line by the single row the secrets door added. Splitting it would mean two places to look for whether a path is declared, which is the one property the file exists to make checkable. |
| `packages/server/src/server-config.ts` | 819 | Exception | One job, and the reason it is one file is the job: turn the environment into typed config in ONE place, so nothing downstream reads `env` inline. It crossed the line when the access-only browser-host rule and the emailed-code sign-in switch arrived, each of which is a resolved value plus the boot warning that fires when the deployment cannot honour it. Splitting by subject would put a variable's default in one file and the warning that explains its absence in another, which is the reading this file exists to keep together. |
| `packages/server/src/server-options.ts` | 1025 | Exception | Everything `createServer` can be handed, and what each option MEANS — one `interface`, lifted verbatim out of `server.ts` so a route can name it without importing the module that imports routes back. It is a declaration plus the reasoning for each default, which is why it is long: 588 of its lines were already this shape inside `server.ts`, where they counted against a file whose row calls the same mass "types, constants and module-scope helpers". **Revisit only if it stops being one type.** Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcserver-optionsts). |
| `packages/server/src/workspace-store.ts` | 572 | Exception | The board registry, moved whole out of `tasks.ts` in A2 — create, rename, retire, delete, the lead seat and doc links, plus the pure `isRetired` / `retiredNotice` / `normalizeWorkspaceName` helpers that live here so `task-agents.ts` can import them without importing the file that imports it. Just over the line, and every verb reads or writes the same `WorkspaceState`; a split would put the retire refusal in one file and the delete that must honour it in another. |
| `packages/server/src/task-agents.ts` | 1284 | Exception | Agents on a board: attachments and the lead seat. The two delivery queues this row used to flag as the next seam — voice change-requests and comments — are now split out, into `agent-voice-queue.ts` (242 lines) and `agent-comment-queue.ts` (249 lines): `AgentStore` composes one instance of each and its own methods delegate to them, so its public API is unchanged. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrctask-agentsts). |
| `packages/server/src/task-goals.ts` | 831 | Exception | The goal bands, moved whole out of `tasks.ts` in A2. It looks like two files — the band list (`setGoalList`, `renameGoal`, `addGoal`, `reorderGoals`) and placement (`setTaskGoal`) — and is deliberately one: placement IS triage on this board, so all five have to agree about what a band change does to the rows sitting in it, and `setGoalList` calls the same sweep `setTaskGoal` does. Splitting them would put that agreement in a comment instead of in one reading. |
| `packages/server/src/tasks.ts` | 3682 | Exception | The verb families the previous row named as the remaining seam are out: `task-authoring.ts` (461 — create, rename, body edits), `task-lifecycle.ts` (479 — the status gate, assignee, due date), `task-archive.ts` (356 — archive/unarchive, task and band), `task-links.ts` (354 — `after` edges and cross-references) and `task-notes.ts` (210 — notes, estimates, artifact checks, reading time), each behind its own narrow persistence interface, the same seam `ReviewItemStore` / `GoalStore` / `AgentStore` / `WorkspaceStore` already use. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrctasksts). |
| `packages/server/src/doc-store.ts` | 4174 | Split | A3 took document mutation out to `doc-edit-ops.ts`, threads to `doc-threads.ts` and the workspace surface to `doc-store-workspaces.ts`; the bindings went to `file-binding.ts`, the fan-out to `live-doc-fanout.ts`, and the activity recorder to `doc-activity-recorder.ts`. Callers reach those collaborators directly now; the one-line forwarders fell from 73 to 13. **M** Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcdoc-storets). |
| `packages/server/src/live-doc-fanout.ts` | 868 | Exception | Who hears about a change to a live doc and over which channel, out of `doc-store.ts`: `wireEvents` and the two meta guards that ride it, `fireEvent` / `fireSuggestionEvent` / `scheduleSummary`, `broadcastToDoc`, the shared presence ticker, and the socket closes a revoked share or a teardown performs. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrclive-doc-fanoutts). |
| `packages/server/src/file-binding.ts` | 3192 | Exception | The file bindings, out of `doc-store.ts`: `attachFile` and its two flat-text twins, the shared mtime sweep, the debounced write-back, the conflict reconcile that arbitrates when doc and disk both moved, and the doc-origin-repo pin. One file because it is one contract, not four subjects — every path is a rule about which side of a bound doc wins, and they are written in terms of each other. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcfile-bindingts). |
| `packages/server/src/doc-store-workspaces.ts` | 1085 | Exception | The workspace surface of a review, out of `doc-store.ts` in A3: the projections that answer "what is in this review" (tree, grouped diff, all-files, thread roll-up, the lazy context and companion opens) and the archive verbs that retire one as a unit. Both walk the same member list — `list()` filtered by `attachmentIdOf` — and the archive path is written in terms of the projections' own vocabulary, so splitting them would leave two files reading one index. |
| `packages/server/src/doc-threads.ts` | 933 | Exception | Comment threads, moved whole out of `doc-store.ts` in A3: open, reply, resolve, reopen, re-anchor, and the review payload a thread can carry. The review verbs look like a second file and are not: a review IS a field on a thread here, all five end in the same `thread.replied` frame, and splitting them would put the payload's rules in one file and the thread they are a property of in another. |
| `packages/server/src/voice.ts` | 1619 | Exception | A6 took the classification to `voice-prompt.ts` and the write guardrail to `voice-action.ts`. What is left is `VoiceRouter` — the one thing here that is not pure. It holds the pending-choice map, the retry window and the completer, and every path through `handle()` ends in an ack plus a `voice.request` event, which is the promise this subsystem makes. Splitting the router further would separate a path from the ack it owes. |
| `packages/server/src/voice-prompt.ts` | 546 | Exception | The words the router runs on and the builder that assembles them around those words. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcvoice-promptts). |
| `packages/server/src/meeting-task-capture.ts` | 898 | Exception | A5 took the prompt and its reader to `meeting-capture-prompt.ts` and the transcript guards to `meeting-capture-guards.ts`. What is left is one pipeline: six intents parsed from one reply, each filed through the same board slice and accumulated into the same `CaptureLinks` the notes read back. The Haiku extractor at the bottom looks separable and is the consent seam this file's header is about — the transcript leaves the machine there, on the dedicated key, or capture stays off — so it belongs with the pass it feeds. |
| `packages/server/src/deploy.ts` | 789 | Exception | A7 took the durable trace to `deploy-log.ts` (282, against an estimated ~250). What is left is one deploy: the decision (`decideDeploy` over `DeployFacts`), the executor (`runDeploy`, `launchctlRestart`, the git runner — the `bun install` one moved to `dependency-install.ts`, which the supervisor runs too) and the single-flight `Deployer` that serialises them. The record's four types went WITH the trace and are imported back — `DeployResult` is a wire format between three processes that never meet, not an internal type of the runner. |
| `packages/server/src/meeting-notes.ts` | 2587 | Split | A5 took the two clocks to `pause-ticker.ts`. What is left is mostly this subsystem's contract surface — the turn, compose, relabel, correction and reattribution shapes every other meeting file imports — plus `beginNotesSession`, the session that produces them. The types are not a file of their own: each one is documented by the verb beside it, and a types file would move the documentation away from the behaviour it describes. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcmeeting-notests). |
| `packages/server/src/task-projection.ts` | 781 | Exception | A2 took `projectTask` out to `task-row.ts`, and which rows a pass writes is `board-row-sync.ts`; what is left is the live-doc lifecycle — `ensureWorkspace`, `refresh`, `scheduleSnapshot` and the debounced snapshot writer — which is one object's behaviour over one `DocStore`. The owner readers (`ownerKindReader`, `claimSessionReader`) still read as a separable pair and would move beside `task-owner.ts`; that is ~90 lines and does not justify a third file on its own. |
| `packages/server/src/meeting-notes-doc.ts` | 1838 | Split | A5 took every section writer to `notes-section-write.ts`. What is left is the sink: the per-doc ownership ledger, the context gather, and the tick handlers that decide WHICH write a tick makes. Just over the line, and all of it reads the same `NotesDocStore` slice. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcmeeting-notes-docts). |
| `packages/server/src/stall-escalation.ts` | 669 | Exception | One `StallEscalations`: the board's own escalation, from deciding the board is dead (`boardDeadFor`) to telling Team Lead, holding off while Team Lead on another server has it, and filing, revising, moving and withdrawing the reader's item when Team Lead is unreachable. **S**, if a second surface ever renders these rows. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcstall-escalationts). |
| `packages/server/src/stall-gate.ts` | 907 | Exception | The pure classifiers behind one wake: `evaluateStalls` sorts the open rows into stalled, unfiled, waiting, undetermined and check-in-due, and `overdueHeldItems` / `overdueAskedBack` do the same for the two review-item findings the same tick carries. 332 of the 566 lines are comment, and that is what the file is FOR. **S**, if the review-item findings ever stop riding the stall tick: they are the one half that reads items rather than tasks, and they would take `HELD_ITEM_DEFAULT_MS`, `HeldItemRow` and `AskedBackRow` with them. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcstall-gatets). |
| `packages/server/src/stall-nudge.ts` | 2118 | Exception | One `StallNudger`: the tick, the arming stamps, and addressing. The held-item nudge (`nudgeFilers`) reuses the same tick, `reachable`, and stamp file, so lifting it out would duplicate all three. |
| `packages/server/src/ready-nudge.ts` | 1116 | Exception | One `ReadyWorkNudger`. Most of the file is the not-sending rules (`armed`, `NudgeTally`) that only make sense against the frame they suppress. |
| `packages/server/src/review-queue.ts` | 684 | Exception | A6 took the ask predicate to `ask-detection.ts` (249, against an estimated ~250). What is left is one queue in three shapes: `reviewThreadItems`, `taskReviewItems` and `reviewItemRows`, which is the whole queue in one order. They share the band rule, the thread source and `classifyActor`'s judgement about who counts as an agent — a second notion of that is the drift this file exists to avoid. |
| `packages/server/src/voice-resolve.ts` | 616 | Exception | A6 took the spoken brief to `voice-status.ts` (187, against an estimated ~190). What is left is one resolver: `tokenize` and the trigram similarity feed `rankTitles`, which feeds `resolveByTitle`, and the intent detectors (`navigationAsk`, `statusAsk`, `boardDestinationAsk`, `goalOrdinalAsk`, `parseOrdinal`, `pickByLabel`) all read the same stopword list and the same confidence floor. It now imports nothing at all. |
| `packages/server/src/middleware/host-guard.ts` | 928 | Exception | One question — may this request proceed on this host. `collabScope` deliberately answers through `shareScopeAllows` rather than a second allowlist, because the allowlist that drifts open is the breach; `classifyHost` and the scope check are two halves of one decision. The share allowlist itself is no longer here: it is the route table's share-visible rows, read through `PARAM_SCOPE`. |
| `packages/server/src/home-brief.ts` | 830 | Exception | One feature end to end: `HomeBriefStore` plus the pure pipeline `briefEvents` → `deterministicBrief` / `buildBriefPrompt` → `acceptBrief`. The network half already lives in `ThreadSummarizer`. |
| `packages/server/src/transcribe-assemblyai.ts` | 767 | Exception | One protocol client end to end: `streamingUrl` builds the v3 session and `createAssemblyAiEngine` speaks the Begin/Turn/Termination sequence; `expiryFrom` and `resolveAssemblyAiKey` serve only that socket. |
| `packages/server/src/meeting-protocol.ts` | 1482 | Exception | One class, `MeetingRelay`. The `/audio/<docId>` socket *is* the meeting lifecycle, so open, frames, and every ending path have to sit together to end it exactly once. The two-stream meeting (2026-09-08) took the fan-out OUT rather than adding it here — `meeting-stream-set.ts` (158) owns opening an engine session per stream and folding two engines' turn ids and speaker labels back into one transcript, which is a different job from ending a meeting exactly once. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcmeeting-protocolts). |
| `packages/server/src/recall.ts` | 674 | Exception | One vendor client: `recallConfigFromEnv`, `buildCreateBotBody`, `createRecallClient`. The callback-URL helpers exist only because Recall dials us back. It also hosts `clip`, the failed-response clipper all three HTTP clients in this family share — A7 put it here because `recall-calendar.ts` and `google-oauth.ts` both call it and neither may import the other. |
| `packages/server/src/client-release.ts` | 602 | Exception | One lifecycle for the numbered release directory: `publishClientRelease`, `currentClientRelease`, `readPublishLedger`, and `prepareClientRelease` — which is the decision the other three exist to make. |
| `packages/server/src/recall-meeting.ts` | 628 | Exception | One class, `RecallMeetingRelay`: invite, webhook status, and the dialled transcript socket are three channels of one bot lifecycle. |
| `packages/server/src/sse.ts` | 900 | Exception | One fan-out. `SseBus` holds `byDoc` and the bounded `replay`; `openSseStream` is the socket that consumes both, including the `replay.gap` path. |
| `packages/server/src/identities.ts` | 587 | Exception | One store — the `Identities` class over `identities.json` — plus its sanitizer and the single projection `userForIdentity`. |
| `packages/server/src/share/share-links.ts` | 852 | Exception | One store, `ShareLinks`: the link records, the membership rows redeeming one writes, and each board's audience, persisted together in `share-links.json`. The audience checks — the link's and the board's — sit inside `isMember` and `roleOf` because those are the questions the per-request gate asks, and a check outside the store would be a second answer to "is this person in" that a new caller could skip. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcshareshare-linksts). |
| `packages/server/src/summarize.ts` | 765 | Exception | One outbound-API owner, `ThreadSummarizer`. `generate`, `generateHomeBrief` and `backfill` share the key resolution, `post`, and the debounce maps that stop three browsers paying three times. |
| `packages/server/src/meetings.ts` | 1127 | Exception | One durable record: the append-only transcript and index paths, the `listMeetings` / `readTranscript` folds over them, and `MeetingStore` as the live handle on the same files. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcmeetingsts). |
| `packages/server/src/meeting-raw.ts` | 773 | Exception | One companion record: the `<docname>-raw-transcript.md` grammar (`formatRawSegment`, `formatRawBullet`, `speakerLineName`), the `meeting.json` tie it is indexed by, the `AudioSink` that writes the audio beside it, and `flushRawSegments` — which is the one function the other four exist to serve, since what is missing from the file is decided by reading the json and the index together. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesserversrcmeeting-rawts). |

## packages/workspaces-app

| File | Lines | Verdict | Reason / seam |
|---|---|---|---|
| `packages/workspaces-app/src/styles.css` | 2959 | Exception | The chrome every page shares, and only that: design tokens, the top bar, voice, the pointer pill, the editor's prose rules, the comment pill, the threads pane, both composers, the toast, the connection and stale-client banners, the read-only bar and the first-arrival identity prompt. B2 took the board's half into `board.css` and the sign-in page's into `signin.css` (12042 -> 6545); this split took the review editor's own surfaces into `doc.css` (6545 -> 2783). Full reasoning: [exceptions-history.md](exceptions-history.md#packagesworkspaces-appsrcstylescss). |
| `packages/workspaces-app/src/doc.css` | 4501 | Exception | The review editor's whole stylesheet — main layout, the review-set sidebar, the workspace file tree, the format bar, the reassign menu, code blocks and tables, the live zone the agent's meeting notes land in, the over-doc sheet, the full-screen thread view and long-thread modal, the code-review and diff-review surfaces, the diff nav and the inline thread cards. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesworkspaces-appsrcdoccss). |
| `packages/workspaces-app/src/board.css` | 7962 | Exception | The board's whole stylesheet, lifted out of `styles.css` in B2 in source order so no rule changed the cascade it lands in. It is one page, and the 28 `##### BOARD · …` sub-banners are the split: a rule goes under the banner naming the surface it paints (`grep -n '##### BOARD' packages/workspaces-app/src/board.css`). Cutting it into files per surface would trade a labelled region for an import graph between stylesheets, and the board loads all of it on every visit either way. |
| `packages/workspaces-app/src/board/board-model.ts` | 1783 | Exception | One model, the board itself: what a row is (`BoardTask`, `ownerKind`, `statusLabel`), which section it lands in (`taskVisible`, `boardSections`, `goalSection`), how much work a goal has left (`boardEffort`, `goalEffortLabel`) and where a drag drops it (`dropTarget`, `stepTarget`). Split out of `board-model.ts` (B1). Cutting it further would separate a row's shape from the ordering rule that reads it, which is the pair `byBoardOrder` exists to keep in one place. |
| `packages/workspaces-app/src/board/board-review-model.ts` | 1516 | Exception | One queue end to end: what a review item is, the ranking that puts everything waiting on a person into one list (`reviewQueue`, `decisionQueue`, `humanBlockerRows`), the walkthrough that walks it (`advanceWalk`, `walkHandoff`), and the wording each row and card wears (`reviewHeadline`, `askedMeta`). Split out of `board-model.ts` (B1). The ranking and the wording are asserted against each other — a row's title is derived from the same ask the rank reads — so a further cut would need both halves imported back. |
| `packages/workspaces-app/src/board/board-presence-model.ts` | 1131 | Exception | One strip of chrome fed by one clock: who is here (`presenceChips`, `leadSeatLabel`), what is running (`pluginDriftNotice`, `clientDriftNotice`, `uptimeSummary`), what has happened (`describeEvent`, `activityRows`) and where the board is standing (`navFromPath`, `homeSinceLabel`). The remainder of `board-model.ts` after B1's other two cuts. `timeAgo` dates a presence chip, a release and a trail row alike, so a further cut would put that one clock behind an import in three places. |
| `packages/workspaces-app/src/board/board-actions.ts` | 920 | Exception | Every REST write the board performs, bound once to an explicit `BoardActionDeps` instead of captured from `main()`'s closure, plus `BoardState` — the projection those writes mutate — and the three primitives every verb ends in (`send`, `fetchJson`, `showToast`). Split out of `board-app.ts` (B1). Splitting the verbs from the state they write, or from the toast that reports a refusal, would put the blast radius back behind an import. |
| `packages/workspaces-app/src/board/board-review-controller.ts` | 639 | Exception | Every write the review queue performs, and each one is the same four steps against a different door: build the request, send it as this reader, say what happened, re-read the queue. It crossed the line by `saveSecretsOnItem`, which is a sibling of `replyToReviewItem` rather than a branch inside it — the split is the security property, since one posts words that get recorded and the other posts values that must reach nothing. Splitting the file would separate verbs that share `send`, `author` and `loadReviewItems`, and put two of them where a reader would not look for the third. |
| `packages/workspaces-app/src/board/board-app.ts` | 984 | Exception | The board's entry, and now only that: `bootBoard`'s environment, the identity and write-gate preamble, the address bar (`currentBoardLocation` / `syncBoardUrl` / `applyHistoryLocation` / `setNav`), and the ordered composition that ends in the first paint. **S**, and only if the address bar ever stops being the thing every region writes through. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesworkspaces-appsrcboardboard-appts). |
| `packages/workspaces-app/src/board/board-detail-panel.ts` | 629 | Exception | One overlay, two things it can be showing — the task panel and the goal panel, out of `board-app.ts`'s render closure in A13. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesworkspaces-appsrcboardboard-detail-panelts). |
| `packages/workspaces-app/src/board/board-detail-render.ts` | 1441 | Exception | One panel: who has the task (`assigneePicker`), what it says (`detailFields`, `bodySlot`), what it cost (`effortFields`, `effortComputationLines`), what it points at (`renderTaskLinks`, `renderRelatedLinks`) and what happened to it (`activityRow`, `renderTransitionRow`). Split out of `board-render.ts` (B1). Larger than the plan's ~900 estimate because the doc-title hydration helpers and `assigneePicker` came with it — both are used only by this panel, and leaving them behind would have pointed `board-render.ts` back at this file. |
| `packages/workspaces-app/src/board/board-render.ts` | 775 | Exception | The board's shell chrome after B1: the topbar, the lead-agent strip, the archived list, the goal detail panel, the quick actions, the review banner, the Home brief and the activity view. Eight small regions that share the shell's own idioms and nothing else; the three regions with a vocabulary of their own are now `board-detail-render.ts`, `board-discussion-render.ts` and `board-review-render.ts`. |
| `packages/workspaces-app/src/meeting-live-zone.ts` | 723 | Exception | The live transcript at the foot of the doc: one element, one closure, and one set of mount-level state that every function in it reads and writes — `turns`, `voices`, `names`, `openChunk`, `settling`, `splitAnchor`, `live` and the stream hold. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesworkspaces-appsrcmeeting-live-zonets). |
| `packages/workspaces-app/src/review-chrome.ts` | 826 | Split | B3 took the two writing surfaces to `doc/review-composer.ts`, the panel resize handle and thread-range clicks to `doc/chrome-panels.ts`, and the shared DOM helpers to `doc/chrome-dom.ts`. **M** Full reasoning: [exceptions-history.md](exceptions-history.md#packagesworkspaces-appsrcreview-chromets). |
| `packages/workspaces-app/src/doc/thread-card.ts` | 1047 | Exception | One comment thread as a card, out of `threads.ts` in B3 — and the same card the redline margin renders as a balloon, which is why it is shared rather than duplicated. It looks like two files, the card and the eight DOM helpers under it, and is deliberately one: every helper has this card as its only caller, and the four faces a card can show (summary, detail, collapsed, answered) are built together because the fold cross-fades between faces that must already exist in the same box. |
| `packages/workspaces-app/src/thread-modal.ts` | 561 | Exception | One dialog and the journey it takes to get there: `mountThreadModal`, the promoted card it paints, and the promote itself — the box growing out of the margin bubble the reader tapped and shrinking back into it. Crossed the line adding that promote. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesworkspaces-appsrcthread-modalts). |
| `packages/workspaces-app/src/redline/markup-margin.ts` | 874 | Exception | B3 took the card builders to `balloon-cards.ts` and the phone sheets to `margin-sheets.ts`. What is left is the margin's own geometry and the render list it measures: `positionBalloons` reads four elements' rects plus the private rendered-balloon union, and `relayout` is the orchestration point that calls the deletion grouper, the thread filter and the renderer in order. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesworkspaces-appsrcredlinemarkup-margints). |
| `packages/workspaces-app/src/diff-nav.ts` | 590 | Exception | One sidebar renderer with two views sharing the toggle, `viewKey` and `diffNavSignature`. The all-files half is ~110 lines and cannot be understood apart from the toggle that selects it. |
| `packages/workspaces-app/src/code/code-editor.ts` | 575 | Exception | One CodeMirror surface: `createCodeEditor` returning `CodeSurface`, with the gutter and decoration internals that only that editor instantiates. |
| `packages/workspaces-app/src/suggest-input.ts` | 539 | Exception | One ProseMirror plugin. `SuggestInput` and the handlers it installs all mutate the same `suggestInputKey` state. |
| `packages/workspaces-app/src/board/task-detail-island.tsx` | 1704 | Exception | The task panel as one Preact island, keyed on `task.id` so a repaint of the same task keeps its DOM — tab, review position, folded capture and half-typed drafts survive without the `keepFields` snapshots the vanilla renderer needed. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesworkspaces-appsrcboardtask-detail-islandtsx). |
| `packages/workspaces-app/src/board/board-island.tsx` | 1555 | Exception | The goal bands and their rows as one island, keyed on task id and goal id so an unchanged row is the same DOM node across a repaint — the property every fix in it reduces to. `TaskRow`, `GoalBand`, `GoalEffort`, the dependency layer and the reorder preview all read `boardData` and the mount-bound `BoardHandlers`, and the drag preview writes marks onto rows `GoalBand` renders. The seam if it grows is `TaskRow` with its controls (`TitleWords`, `StatusControl`, `OwnerControl`, `TaskBadges`), about 500 lines. First counted when `loc:audit` started reading `.tsx`. |
| `packages/workspaces-app/src/board/walkthrough-island.tsx` | 1228 | Exception | One card at a time from the review queue, keyed on `ReviewItem.key` so expansions and drafts are component state rather than DOM snapshots. `WalkCard` (about 300 lines) composes the head, body, options, question box and ask-thread parts beside it, and every part takes the per-paint `WalkthroughHandlers` that ride the signal because they close over this item and the next. The parts are small and have no other caller. First counted when `loc:audit` started reading `.tsx`. |
| `packages/workspaces-app/src/board/goal-detail-island.tsx` | 672 | Exception | The goal panel as one island: `GoalDetailPanel` (about 450 lines) plus the archive-confirm wording and the view signal. It is one component because it is one panel, keyed on the goal id; the title `<h2>` and the description slot are deliberately left out of Preact's children so the in-place rename and the Tiptap editor keep their nodes, and that arrangement is easier to check in one function. First counted when `loc:audit` started reading `.tsx`. |
| `packages/workspaces-app/src/board/schedule-editor.tsx` | 588 | Exception | The task panel's schedule section: the phrase and the chips are two views of one rule, so `ScheduleEditor` (the phrase) and `ScheduleChips` (the chips) both edit the same `SchedulePhrase` and rewrite each other. Splitting them would put the rule's two views in two files. First counted when `loc:audit` started reading `.tsx`. |

Every workspaces-app seam above moves symbols within one entry's import graph, so
the shipped bundle is unchanged.

## packages/core

| File | Lines | Verdict | Reason / seam |
|---|---|---|---|
| `packages/core/src/prose-markdown.ts` | 1563 | Exception | Markdown in and markdown out, out of `prose.ts` in B5, and deliberately one file rather than a parser and a serializer. They are one grammar: a mark the parser learns and the serializer does not emit is a doc that loses text on its next flush, so the two halves of that invariant must be readable together. `applyMarkdownToFragment` is the pair composed under an LCS diff, which is what makes a reparse touch only the blocks that changed. |
| `packages/core/src/review-item.ts` | 588 | Split | The contract types are `review-item-types.ts` (row below), which emits nothing, so `review-item-wire.ts` reaches them without importing the verbs back. The quality gate's half is now `review-item-gate.ts` (159): `isReviewItemHeld` / `isReviewItemGated` / `isReviewPayloadHeld` / `isReviewPayloadGated`, `reviewPayloadVersion`, the two `judgeReason*` renderers and `storedJudgement` / `withoutHoldHistory`, which read a verdict nothing else here writes. **S** Full reasoning: [exceptions-history.md](exceptions-history.md#packagescoresrcreview-itemts). |
| `packages/core/src/review-item-types.ts` | 577 | Exception | One wire contract, all data and mostly prose: the twelve review-item shapes lifted out of `review-item.ts` in the split the row above describes. It emits nothing — no function, no constant — so there is no behaviour here to separate from anything else, and a second file would be the same contract read in two places. **S** Full reasoning: [exceptions-history.md](exceptions-history.md#packagescoresrcreview-item-typests). |
| `packages/core/src/prose-edit.ts` | 1182 | Exception | The two ways an agent edits prose without a cursor, out of `prose.ts` in B5: by what the text says (`locateMatches`, `findAndReplace`) and by a stored pair of relative positions (`rewriteRange`, `insertAfterRange`). One subject, not two — they share the covering-mark machinery, the near-miss hints a failed find returns, and the table-row path, and every one of them wraps its mutation in the same single transaction. |
| `packages/core/src/route-templates.ts` | 497 | Keep | One data table and the matcher that reads it: every route this server answers, as a whole-path template, so a span is named by the route rather than collapsing to `:id` segments. The table is generated from `ROUTE_TABLE` by `bun run routes:table` (core cannot import the server) and grows by one line per route the server adds; `packages/server/test/route-templates-drift.test.ts` fails when it is stale. Full reasoning: [exceptions-history.md](exceptions-history.md#packagescoresrcroute-templatests). |
| `packages/core/src/prose-blocks.ts` | 770 | Exception | Whole-block edits and the agent anchors that name where, out of `prose.ts` in B5. Everything else in that family edits text inside a block; this is the file that changes the document's shape. Anchors ship with block deletion because they are one contract read from two ends — an anchor promises a place can be found again, deleting the block it names is the edit that breaks the promise, and `autoReanchorDoc` is what runs afterwards. |
| `packages/core/src/task-wire.ts` | 900 | Exception | One wire contract, all data: `Task` alone is ~415 documented lines, plus `TASK_STATUSES`, `Ref`, `ArtifactCheck` and the single `byBoardOrder`. Splitting it would put one row's shape in two files, which is the drift the file exists to prevent. |
| `packages/core/src/meeting.ts` | 516 | Exception | One wire contract for the meeting socket, all data: the client and server message unions with the reasoning for each field on the field itself, plus the capture mode and speaker-cap constants both ends resolve from. It crossed the line on 2026-09-16 by one field — the `ready` frame's carried speaker cast — and splitting the union in two would put half a protocol in a file the other half does not import, which is the drift every other `*-wire.ts` row here exists to prevent. The prose that would otherwise live in this file is `docs/architecture/meeting-assistant.md`. |
| `packages/core/src/speaker-tags.ts` | 835 | Exception | One tag format end to end: `speakerTagHref` and `parseSpeakerTagHref` define it, and `findSpeakerTags` / `normalizeSpeakerTags` / `reattributeSpeakerTags` are the operations on it over a shared `SpeakerTagMatch`. |
| `packages/core/src/suggest-ops.ts` | 801 | Exception | One registry and its mutations over a Y.Doc: `scanSuggestions` builds the read model that `acceptSuggestion` / `rejectSuggestion` / `resolveAllSuggestions` then act on, all through the shared `resolveOne`. |
| `packages/core/src/types.ts` | 846 | Exception | One cohesive type registry — `DocType`, `DocMeta`, the `Anchor` union, `Thread` / `Comment`, `WebhookPayload` — with a single function, `contentKind`, which is the table the rest branch on. |
| `packages/core/src/plot-spec.mjs` | 1993 | Keep | The `<PlotChart>` spec turned into an Observable Plot chart without evaluating anything. Other repos copy this file verbatim and compare the version line and the sha256 its first line records (`scripts/plot-spec-stamp.ts` writes and checks it), so a split would change what they copy and the hash they check; plain JavaScript importing nothing, by the same contract. Most of the length is the two presets (`stackedArea`, `lines`) and the inside-label layout they share. First counted when `loc:audit` started reading `.mjs`. |

## packages/mcp

| File | Lines | Verdict | Reason / seam |
|---|---|---|---|
| `packages/mcp/src/tools/workspace.ts` | 870 | Exception | The third of the same shape: one dispatch family — the arms addressed to a board rather than to a document or a row — over one shared context, plus `setBoardRetired`, which two of them are. Length is a count of tools, not of coupling. |
| `packages/mcp/src/tools/tasks.ts` | 1318 | Exception | The other half of the same shape as `tools/docs.ts` below: one dispatch family — every arm that addresses a task, by `taskId` or by a `reviewItemId` that resolves to one — over one shared context. The four helpers with it (`TaskPayload`, `taskCreatedSummary`, `heldResult`, and the two review-item lookups) have no reader anywhere else, which is why they are here and why moving them out would only add a file. Length is a count of tools, not of coupling. |
| `packages/mcp/src/tools/docs.ts` | 1066 | Exception | One dispatch family: every arm that names a `docId`, over one shared context, in the order they stood in the switch. Cutting further would put one `switch` across two files and re-open the question the domain split just answered — which file a tool is in — for no reader's benefit, since nobody reads an arm they did not come looking for by name. The arms are independent by construction, so length here is a count of tools, not of coupling. |
| `packages/mcp/src/tool-schemas.ts` | 3245 | Exception | Declarative data, not code: the `tools/list` result — 94 tool schemas, names, descriptions and JSON Schema, with no logic and no branch in the file. The split that created it is what the `mcp.ts` row above asked for, and B6 accepted the size in advance: one table read top to bottom is what an agent picks a tool from, and cutting it into three would mean choosing which third a reader looks in. Splitting is possible the day a subset stops being read as one list. |
| `packages/mcp/src/channel-messages.ts` | 730 | Exception | One dispatch: every board and doc event this session receives, turned into the one channel line an agent reads. The per-event WORDING is already out of it — `nudge-line.ts`, `decision-line.ts`, `scheduled-line.ts`, `voice-line.ts` and the rest are what the arms call — so what is left is the switch itself plus the two payload types the arms read fields off. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesmcpsrcchannel-messagests). |
| `packages/mcp/src/nudge-line.ts` | 1335 | Exception | One responsibility, the wording of the board's wake events. `readyIdleLine`, `stalledLine`, `reviewItemHeldLine` and `reviewAnsweredLine` share `truncate` and `humanDuration`, and the point is that the wording is asserted in one place. Most of the length is the reasoning behind particular sentences, written beside the sentence rather than in a doc nobody opens while editing one. |

## packages/widget

| File | Lines | Verdict | Reason / seam |
|---|---|---|---|
| `packages/widget/src/widget.ts` | 769 | Exception | What is left of the custom element after B7 took the three method clusters out: `widget-auth.ts` (284), `widget-picker.ts` (232) and `widget-threads.ts` (297). The remainder is one object — the element's own lifecycle. Construction, `init`, the attribute upgrade, the context it keeps in step with `location`, the WebSocket, the shadow-DOM shell, the three posting verbs the other modules reach through, and the observer that schedules a render. Every one of those reads the element's fields directly, and a further split would trade them for an interface. |

## packages/plugin

No file in this package is over the limit. `hooks/lib/agent-notes.ts` was,
until B8 took the reduction out to `note-redact.ts` (430) and left the hook
plumbing at 241.

---

## Test files

113 test files exceed 500 lines (measured 17 Oct 2026, now that `.tsx` counts).
The first is listed with a verdict because its row records a split; the rest
are exceptions, listed after it. The recurring shape across the exceptions is
one feature tested at two or three *layers* — pure predicate, then store, then
real HTTP route — sharing the same fixture builders. That is one harness.

| File | Lines | Verdict | Reason / seam |
|---|---|---|---|
| `packages/workspaces-app/test/board-render.test.ts` | 3907 | Exception | Twelve describes over one harness: the module-scope `task()` factory and the `root` beforeEach, asserting rendered DOM. The six that `readFileSync` `styles.css` and board source and assert on text moved to `board-source-contract.test.ts` in B1 — they were the second harness this row named. |

The remaining 112 are exceptions. Each row names the one harness its cases share.

| File | Lines | Reason |
|---|---|---|
| `packages/workspaces-app/test/board-model.test.ts` | 2491 | All describes are pure model functions fed by the one module-scope `task()` factory. |
| `packages/workspaces-app/test/comments-in-view-driver.ts` | 1328 | Not a suite — ONE browser page, for the same reason as `meeting-live-overdraw-driver.ts` below. Its fourteen arms each mount the real editor and column through one `mount()`, read geometry through one `read()`, and are bundled into the page as one module by `comments-in-view.test.ts`. Splitting it would buy a bundle and a `window.*` entry point per arm, paid on every launch. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesworkspaces-apptestcomments-in-view-driverts). |
| `packages/workspaces-app/test/comments-in-view.test.ts` | 503 | Five describes over ONE harness, and the harness is a browser launch: `probeFor` hands every case the same `Probe`, so the suite pays for two Chrome launches rather than two per describe. Splitting a describe out is another launch, another bundle build and another profile to clean up. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesworkspaces-apptestcomments-in-viewtestts). |
| `packages/workspaces-app/test/meeting-live-overdraw-driver.ts` | 752 | Not a suite — ONE browser page, and everything in it shares the page: the meeting driver, the paint sampler and the three built controls run against one mounted zone, one `WORDS` cursor and one scaled clock, bundled as one module by `meeting-live-overdraw.test.ts`. Splitting it would buy a second bundle and `window.*` entry point per control, paid on every launch. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesworkspaces-apptestmeeting-live-overdraw-driverts). |
| `packages/workspaces-app/test/meeting-live-zone.test.ts` | 654 | Three describes over one harness: the module-scope `parent` / `clock` beforeEach and the `zoneEl` / `turns` / `chunkEl` / `slotEl` readers. The settle describe adds fake timers and the never-moves-the-page describe adds `fakeLayout`; both still drive the zone the first one builds. |
| `packages/server/test/meeting-notes.test.ts` | 3512 | Every describe drives the notes pipeline off the module-scope `ManualScheduler`. |
| `packages/server/test/secret-review-item.test.ts` | 592 | Exception | One harness, and it is most of the file: a real route table behind a real Cloudflare Access fixture with a signed reader per role, an injected writer that records what it was handed, and a sweep over the data directory that is first shown finding a string that IS written there. Full reasoning: [exceptions-history.md](exceptions-history.md#packagesservertestsecret-review-itemtestts). |
| `packages/server/test/widget-door-http.test.ts` | 601 | Exception | One harness over one real server: a signed Cloudflare Access fixture for the owner, a door hostname, a sign-in origin, a temporary widget build to serve and the board and doc fixtures every refusal is measured against. Each describe is one property of the tailnet door (tokenless refusals, board match, origin match, expiry and the watermark, the routes it must not reach, the mint's allowlist), and each keeps a positive control on the same server. Splitting one out copies the Access fixture and the boot into a second file for cases that differ only in the token they present. |
| `packages/workspaces-app/test/markup-margin.test.ts` | 2019 | All 17 describes mount through `mountSurface` / `mountMargin` and share the `afterEach` teardown list. |
| `packages/core/test/prose.test.ts` | 1662 | Every describe seeds a `Y.XmlFragment` via `seedDoc()` and its two anchor helpers. |
| `packages/workspaces-app/test/review-walkthrough.test.ts` | 1573 | All describes build fixtures with `task()` / `threadItem()` and render through `renderHomeReview` against the shared `root`. |
| `packages/server/test/review-item-gate.test.ts` | 1633 | A single top-level describe over one real server and the SSE `listenFrames` harness. |
| `packages/core/src/review-item.test.ts` | 1446 | All 22 describes exercise the review-item payload vocabulary off the `decision()` / `review()` builders. |
| `packages/server/test/review-queue.test.ts` | 1429 | Every describe feeds `comment()` / `thread()` fixtures into the queue functions. |
| `packages/server/test/meeting-task-capture.test.ts` | 1397 | All describes share `boardStub()` / `extractorOf()` and drive one capture pipeline. |
| `packages/core/src/goal-effort.test.ts` | 1322 | Every describe builds effort inputs with `ok()` / `task()` / `closed()` / `identity()`. |
| `packages/server/test/host-guard.test.ts` | 2144 | 16 describes, all pure predicates over the one module-scope `LOCAL` host fixture. |
| `packages/server/test/task-routes.test.ts` | 1231 | One top-level describe; every nested suite uses the same `beforeAll` server and tmpdir. |
| `packages/server/test/meeting-notes-doc.test.ts` | 1379 | All describes build a Y.Doc via `docFrom()` and read it back with `markdownOf()`. |
| `packages/server/test/host-scope.test.ts` | 1128 | Both describes stand up the real route table over `makeMockCfApi()` — one guard, two share modes. |
| `packages/server/test/server.test.ts` | 1037 | Each describe builds the same tmpdir and `createServer` handle; the `decideReconcile` suite is a helper of that code path. |
| `packages/server/test/voice.test.ts` | 1008 | A single describe over one real server with an injected `complete`. |
| `packages/server/test/workspace-lead.test.ts` | 951 | Every describe constructs a `TaskStore`, or a server over one, for the same lead-seat contract. |
| `packages/server/test/review-item-routes.test.ts` | 961 | The module-scope `handle` / `base` server plus `mkdoc()` / `seedThread()` feed all nine describes. |
| `packages/server/test/ready-nudge-routes.test.ts` | 952 | A single describe over one real board, stream, and the `listenFrames` / `waitForFrames` harness. |
| `packages/server/test/ready-nudge.test.ts` | 917 | All describes run the nudger through the module-scope `board()` and `harness()` fake world. |
| `packages/server/test/task-tool-routes.test.ts` | 990 | One describe, one `beforeAll` server, four routes. |
| `packages/server/test/stall-escalation.test.ts` | 629 | Four describes over one subject: the liveness test (`boardDeadFor`), the filer against a real `TaskStore` with a fake Team Lead reach, the loop isolation, and the words a reader sees. They share `board()`, `row()` and `queued()` — the last is the reason they stay together, since half these tests are about the difference between an item being open and the reader's queue actually showing it. |
| `packages/server/test/stall-nudge.test.ts` | 1635 | All describes drive the stall pass through `board()` and `harness()`. |
| `packages/server/test/stall-wake-blame.test.ts` | 590 | One incident, two defects, and the controls that discriminate them: every describe drives the same `board()` through a real `StallNudger` and renders the frame with the real `stalledLine`. Most of the length is the cry-wolf controls — dropping any one of the renderer's twenty-four known key names fails at least one case here, which is what makes the set a discriminator rather than a list nobody checks. Splitting them from the cases that mutate the frame would leave the mutations green against a control in another file. |
| `packages/server/test/transcribe-assemblyai.test.ts` | 938 | Every describe runs the mapping over the module-scope `FakeSocket` and `harness()`. |
| `packages/server/test/mcp-durable-watches.test.ts` | 909 | All three describes spawn the shipped MCP bundle through the `McpChild` class against a real server. |
| `packages/server/test/review-item-comments.test.ts` | 866 | A single describe over one real server. |
| `packages/server/test/attachments.test.ts` | 880 | Pure, store and route describes all exercise one `AgentAttachment` record shape with shared `readAudit` / `listen` helpers. |
| `packages/server/test/deploy-runner.test.ts` | 788 | Every describe builds deps via `fakeGit()` / `deps()` / `fakeWait()`. |
| `packages/workspaces-app/test/thread-card.test.ts` | 817 | Nine describes, all through `mountPanel()` and `makeThread()`. |
| `packages/server/test/board-share.test.ts` | 1168 | A single describe over one server with `connectDoc` / `readSseUntil` helpers. |
| `packages/server/test/summarize.test.ts` | 910 | Every describe injects `fakeFetch()` into a `ThreadSummarizer` over `thread()` fixtures. |
| `packages/mcp/test/review-item-tools.test.ts` | 983 | All describes speak JSON-RPC to the one spawned bundle child via `call()` / `last()`. |
| `packages/workspaces-app/test/thread-morph.test.ts` | 847 | Every describe mounts via `mountCard()` and inspects `recordAnimations()`. |
| `packages/server/test/bind-diff.test.ts` | 762 | Both describes build the same `makeFixtureRepo()` git fixture; `makeDocStore` extends it rather than replacing it. |
| `packages/server/test/goal-ids.test.ts` | 741 | Every describe seeds a `TaskStore`, or a server over one, for the same goal-id contract. |
| `packages/server/test/meeting-socket.test.ts` | 861 | Seven describes, each a real server plus the shared `AudioClient` class, varying only engine config. |
| `packages/server/test/access-share-scope.test.ts` | 785 | One describe, one `beforeAll` server, nested suites over the one Access-mode share the shared harness mints. Converted from `link-share.test.ts` when link mode was retired. |
| `packages/server/test/goal-reorder.test.ts` | 695 | Store and route describes both seed goals with `bands()` / `seededGoalList()`. |
| `packages/server/test/stall-nudge-routes.test.ts` | 768 | A single describe over one real board plus `listenFrames` / `waitForFrames`. |
| `packages/server/test/home-brief.test.ts` | 687 | Every describe feeds `ev()` / `input()` rows into the brief pipeline, store included. |
| `packages/server/test/meeting-ask-cues.test.ts` | 662 | The detector describes and the `parseTaskCaptureReply` describes are the two halves of one convention, and the second reads the first: every licensing case is built from the same phrase tables the first half asserts, over the shared `candidates` / `reply()` fixture. |
| `packages/server/test/sse-replay.test.ts` | 873 | Every describe exercises an `SseBus` stream through the shared `listenFrames()` and `settle()`. |
| `packages/server/test/refresh-workspace.test.ts` | 660 | All three describes build a `DocStore` through the module-scope `makeDocStore(dataDir)` and `git()` helpers. |
| `packages/server/test/auth-write-gate.test.ts` | 682 | Every case, HTTP and y-sync socket alike, boots through the one `boot(requireSignInToWrite)` harness. |
| `packages/server/test/voice-hardening.test.ts` | 654 | The prompt, resolver and handle describes share the file's `PERSON` / `AGENT` / `INJECTION` fixtures with the one end-to-end describe. |
| `packages/server/test/decision-routes.test.ts` | 699 | One describe with one `beforeAll` server; every assertion reads an effect back over the same REST base. |
| `packages/workspaces-app/test/board-detail-css.test.ts` | 871 | Every describe parses the same `CSS` string through the shared `rule()` / `media()` helpers. |
| `packages/server/test/task-import.test.ts` | 618 | The parser describes and the route describe both exercise `parseTrackerMarkdown` on the same synthetic tracker fixture. |
| `packages/server/test/goal-rename.test.ts` | 634 | Store and route describes share the `bands()` / `boardFor()` goal-id fixture builders. |
| `packages/server/test/sentry-server.test.ts` | 732 | All describes drive `src/sentry.ts` against the module-scope `startCaptureServer()` harness. |
| `packages/server/test/agent-watches.test.ts` | 774 | Store and route describes share the `AgentWatches` data-dir fixture. |
| `packages/server/test/comment-durability.test.ts` | 613 | Both describes use the shared `listenFrames()` / `settle()` SSE harness against the agent comment queue. |
| `packages/server/test/share-link-flow.test.ts` | 1712 | Eight describes over one server: the share hostname, the owner hostname, two boards and a doc on each. The two-audience fixture is the point — every cross-check case is vacuous without both, so splitting the file would mean building it twice. |
| `packages/server/test/parallelism-cap.test.ts` | 602 | Both describes assert the same workspace cap through the shared frame harness. |
| `packages/server/test/owner-kind.test.ts` | 621 | The pure `resolveOwnerKind` tables and the HTTP describes are two declared layers of one decision over shared fixtures. |
| `packages/core/test/thread-summary.test.ts` | 646 | Every describe builds its subject with the module-scope `makeThread()` ydoc builder. |
| `packages/server/test/meeting-e2e.test.ts` | 649 | One describe over the `ManualScheduler` / `AudioClient` / `waitFor` harness. |
| `packages/server/test/doc-eviction.test.ts` | 702 | Both describes drive the same injected-clock DocStore eviction fixture and the shared `onDisk()` reader. |
| `packages/server/test/member-boundary-lows.test.ts` | 796 | Six describes over ONE Access-fronted server, two boards, a doc, a thread and a row on each — the fixture IS the subject (a member of board A doing things about board B), and a second copy of it in a second file would be the thing most likely to drift out of agreement with the first. |
| `packages/server/test/collab-host.test.ts` | 954 | All three describes depend on the module-scope `jwks` / `signJwt` `beforeAll` and boot the same server shape. |
| `packages/server/test/task-review-queue.test.ts` | 678 | Module-scope `handle` / `base` plus `seedWorkspace` / `seedDecision` feed every describe. |
| `packages/server/test/task-review-item-routes.test.ts` | 629 | A single describe and one `beforeAll` server; every case is a write route read back over HTTP. |
| `packages/workspaces-app/test/footnote-notes.test.ts` | 673 | Nine describes over one `mount()` — a Y.Doc of note-bearing markdown, a real editor and the notes module — reading the same three draws back off it. The subject is one module's rendering: the margin caption, the tap popover and the printed list, plus what a note's links, backtick spans and fact underline do in each. Splitting by draw would give each half a copy of `mount` and of the `supFor` / `factFor` / `tap` readers, and would file a case about a link in the margin away from the same case about the same link in the popover. |
| `packages/core/test/summary-generated.test.ts` | 581 | All describes are pure summary-module functions over the shared `thread()` builder. |
| `packages/server/test/agent-coverage.test.ts` | 625 | One top-level describe around the watch-coverage route; the nested block reuses the same server fixture. |
| `packages/server/test/meetings.test.ts` | 617 | Four describes, each constructing the same `MeetingStore`-on-disk fixture in an identical `beforeAll`. |
| `packages/core/test/suggest-ops.test.ts` | 740 | Every describe builds a Y.Doc with `docFrom()` and reads it back with `serialize()`. |
| `packages/server/test/recall-meeting.test.ts` | 649 | One describe over the `FakeRecall` / `ManualScheduler` / `transcriptFrame()` vendor harness. |
| `packages/mcp/test/nudge-line.test.ts` | 1296 | All describes call the pure `*Line()` renderers with inline row literals; no setup exists to be disjoint. |
| `packages/server/test/board-workspace-delete.test.ts` | 551 | One top-level describe over one `seed()` board and the shared `del()` / `post()` helpers; every case is the same DELETE answering a different footprint. |
| `packages/widget/test/widget-auth.test.ts` | 880 | Every describe runs against the module-scope `stubGlobals()` / `importWidget()` widget harness. |
| `packages/workspaces-app/test/thread-modal.test.ts` | 821 | All describes mount through the shared `mount()` harness and its `comment()` / `thread()` builders. |
| `packages/server/test/proxied-trusted-host.test.ts` | 587 | All describes depend on the module-scope `jwks` / `signJwt` `beforeAll` and the shared `get()` helper. |
| `packages/server/test/task-review-items.test.ts` | 552 | A single describe over one `TaskStore` fixture and the shared `payload()` builder. |
| `packages/server/test/grouping-share-removed.test.ts` | 632 | One describe using the shared `makeMockCfApi()` Cloudflare stub and one server. |
| `packages/server/test/meeting-notes-correction.test.ts` | 582 | Predicate describes and the real notes-doc describes all build their subject with `docFrom()` / `NOTES()`. |
| `packages/server/test/recall-callback-gate-http.test.ts` | 565 | Every describe uses the module-scope `spinUp()` / `callback()` / `signBody()` two-hostname harness. |
| `packages/workspaces-app/test/md-composer.test.ts` | 543 | Every describe drives the one composer through the module-scope `mount()` / `surfaceOf()` helpers; the stylesheet describes now install the page's sheets over that same mount rather than grepping `styles.css`, which is what took it over the line. |
| `packages/server/test/stall-gate.test.ts` | 629 | Every describe calls the module-scope `evaluate()` over rows from `task()`; no server anywhere. |
| `packages/workspaces-app/test/goal-actions.test.ts` | 578 | Pure model describes and DOM-panel describes share `task()` / `handlers()` / `sectionOf()` for one feature. |
| `packages/workspaces-app/test/activity-model.test.ts` | 598 | All describes are pure Home-activity functions over the shared `task()` / `note()` / `groups()` builders. |
| `packages/server/test/share-grouping-scope.test.ts` | 607 | One describe over the shared `connectDoc()` / `git()` fixture and a single `beforeAll` server. |
| `packages/workspaces-app/test/thread-modal-chrome.test.ts` | 544 | Every describe mounts the review chrome via `harness()` on the same `mountChromeDom()` / `fakeSurface()` base. |
| `packages/server/test/voice-actions.test.ts` | 539 | One describe, one `beforeAll` server; all cases route spoken verbs through it. |
| `packages/server/test/projection.test.ts` | 628 | One describe over the shared `connectDoc()` / `listen()` / `auditLines()` Yjs-client harness. |
| `packages/server/test/artifact-check.test.ts` | 522 | Classifier, store and server-wiring describes are the layers of one check and share `prRef` / `fetchStub`. |
| `packages/server/test/git-ops-vs-bound.test.ts` | 634 | Both describes build a real git repo with the shared `git()` / `cleanEnv()` helpers; `classifyExternalContent` is the bound-doc path's own classifier, not a foreign subsystem. |
| `packages/server/test/tasks.test.ts` | 519 | `TaskStore` and the small `Ref` describe share the one store and dataDir fixture. |
| `packages/server/test/effort-estimate-gate.test.ts` | 561 | A single describe with one stub-estimator server fixture. |
| `packages/server/test/cross-origin-routes.test.ts` | 530 | Both describes stand up a real server and probe it from the module-scope `EVIL` origin for the `CANARY` body; the trusted host and the public share host are two modes of one guard, not two harnesses. |
| `packages/server/test/sync-clobber.test.ts` | 615 | Both describes exercise the same write-back clobber path over the shared `makeDocStore()` / `writeExternal()` fixtures, one directly and one over HTTP. |
| `packages/workspaces-app/test/mobile-review.test.ts` | 516 | Every describe uses the shared `harness()` mount plus `comment()` / `thread()` / `orphanThread()`. |
| `packages/server/test/live-doc-fanout.test.ts` | 513 | Five describes over one fixture pair — `makeDoc()` and the recording `makeHost()`. Broadcast, thread frames, socket sweeps, presence and `wireEvents` are the stages of one frame's journey through the same fan-out object, and every case is built from those two helpers. |
| `packages/server/test/home-routes.test.ts` | 517 | All four describes construct their server via the one `makeHarness(summarizer?)` factory. |
| `packages/workspaces-app/test/write-gate.test.ts` | 596 | Every describe uses the module-scope `beforeEach` DOM reset with `docShell()` / `boardShell()`. |
| `packages/server/test/notes-method-switch.test.ts` | 808 | The five describes are the five places one switch is decided — the socket frame, the at-rest route, the live refusal and its bot exception, the trace line, and the composer dispatch — and each stage is asserted against the state the previous one left. Splitting them would duplicate the `session()` notes fixture and the `put()` route driver into files that only make sense read in order. |
| `packages/server/test/dispatch-routes.test.ts` | 546 | One describe over the shared `listenFrames` / `waitForFrames` fake-watcher server harness. |
| `packages/server/test/project-machine-deploy-settings.test.ts` | 573 | Every case runs `deployProject` end to end over one harness: stand-in `fly`, `security` and `gh` scripts on PATH, a loopback bucket, and the files they answer from. It crossed 500 when the lead deploy-key check (review L4) added the `gh` stand-in and its refusal case, and grew by the CI cases for a token that reaches one app (no org app list, no tunnel token off the Mac). The pure `plan` cases at the end are 24 lines and would not bring it under. |
| `packages/workspaces-app/test/board-island.test.tsx` | 2069 | Ten describes over one harness: the module-scope `task()` / `handlers()` factories, the `beforeEach` that mounts the island, and `repaint()` writing `boardData`. The contract, rename, caret, reorder and assignee cases all assert on the same mounted rows. |
| `packages/workspaces-app/test/goal-effort.test.tsx` | 1076 | The effort model at its layers — `boardEffort` / `goalEffortLabel` as pure functions, then the rendered board and ticket — all built from the module-scope `task()` / `closed()` factories and pinned `NOW`. |
| `packages/workspaces-app/test/home-activity-island.test.tsx` | 1027 | Every describe mounts the island through the one `mount()` (and `pane()` over it at a viewport) on the `task()` / `note()` fixtures, with the stylesheets installed in the module-level `beforeEach`. |
| `packages/workspaces-app/test/review-item-comments.test.tsx` | 986 | Model and walkthrough describes share the `ticketRow()` / `revisedRow()` / `decisionTask()` fixtures and the module-level DOM reset; the card cases mount through `mountWalk()` / `mountHome()`. |
| `packages/workspaces-app/test/task-detail-island.test.tsx` | 815 | Every describe drives the island through `mount()` and the `taskDetailData` signal (`repaint()` / `openActivity()`) over the `task()` / `handlers()` fixtures. |
| `packages/workspaces-app/test/scheduled-section.test.tsx` | 710 | One feature at two layers — where `boardSections` puts a scheduled row, then the row on screen through `paint()` — over the `task()` / `weekdays9()` fixtures and pinned `NOW`. |

---

## Split queue

Ordered by how much a split reduces the chance that an ordinary PR lands in a
god file: commits over the last 90 days first, size second. Churn is the column
that matters — `recall-calendar.ts` has a clean seam and one commit in three
months, so splitting it buys almost nothing.

| # | File | Lines | Commits (90d) | Size |
|---|---|---|---|---|
| 1 | `packages/server/src/server.ts` (split in A1 and A12) | 7131 | 233 | M |
| 2 | `styles.css` + `board.css` + `signin.css` (split in B2) | 12042 | 158 | M |
| 3 | `mcp.ts` + `tool-schemas.ts` + `tools/` + the eight modules lifted for coverage (all under `packages/mcp/src`, split in B6 and again for coverage) | 5563 | 156 | done |
| 4 | `board-app.ts` + the fifteen modules split out of it (A11 and A13) | 3880 | 102 | S |
| 5 | `packages/workspaces-app/src/board/board-render.ts` | 2707 | 95 | M |
| 6 | `board-model.ts` + `board-review-model.ts` + `board-presence-model.ts` (was `board-model.ts`, split in B1) | 3645 | 89 | M |
| 7 | `tasks.ts` + `task-authoring.ts` + `task-lifecycle.ts` + `task-archive.ts` + `task-links.ts` + `task-notes.ts` (split from `tasks.ts`) | 4945 | 87 | done |
| 8 | `doc-store.ts` + `file-binding.ts` + `live-doc-fanout.ts` (split in A10, fan-out lifted after) | 4801 | 71 | M |
| 9 | `app.ts` + the nine phase modules under `src/doc/` (split for the markdown mount) | 1959 | 55 | done |
| 10 | `packages/server/src/task-projection.ts` | 743 | 43 | done |
| 11 | `review-chrome.ts` + `doc/thread-projection.ts` + `doc/thread-actions.ts` + `doc/view-prefs.ts` + `doc/anchor-body.ts` (was `review-chrome.ts`, split in B3 and again on 2026-09-03) | 1409 | 24 | M |
| 12 | `thread-card.ts` + `threads.ts` (was `threads.ts`, split in B3) | 1230 | 20 | done |
| 13 | `meeting-protocol.ts` + `meeting-chooser.ts` + `meeting-feed.ts` + `meeting-menu.ts` + `meeting-strip.ts` (was `meeting-strip.ts`, split in B4 and again after it) | 1953 | 18 | done |
| 14 | `review-item-check.ts` + `review-item-wire.ts` + `review-item-types.ts` + `review-item.ts` (split in B5, contract lifted after) | 1979 | 18 | done |
| 15 | `prose-fragment.ts` + `prose-markdown.ts` + `prose-edit.ts` + `prose-blocks.ts` + `prose.ts` (was `prose.ts`, split in B5) | 2847 | 16 | done |
| 16 | `review-queue.ts` + `ask-detection.ts` (split in A6) | 831 | 15 | done |
| 17 | `widget.ts` + `widget-auth.ts` + `widget-picker.ts` + `widget-threads.ts` (split in B7) | 1411 | 13 | done |
| 18 | `packages/server/src/meeting-notes.ts` + `pause-ticker.ts` (split in A5) | 1039 | 12 | done |
| 19 | `voice.ts` + `voice-prompt.ts` + `voice-action.ts` (split in A6) | 2109 | 11 | done |
| 20 | `packages/server/src/meeting-notes-doc.ts` + `notes-section-write.ts` (split in A5) | 986 | 11 | partly deleted |
| 21 | `activity.ts` + `actor-identity.ts` (split in A7) | 582 | 11 | done |
| 22 | `packages/workspaces-app/src/redline/markup-margin.ts` | 827 | 9 | done |
| 23 | `meeting-task-capture.ts` + `meeting-capture-prompt.ts` + `meeting-capture-guards.ts` (split in A5) | 1348 | 6 | done |
| 24 | `meeting-notes-merge.ts` + `notes-ownership.ts` + `notes-section.ts` (split in A5) | 1067 | 5 | deleted |
| 25 | `deploy.ts` + `deploy-log.ts` (split in A7) | 1058 | 4 | done |
| 26 | `effort-task.ts` + `effort-calibration.ts` + `effort-format.ts` + `goal-effort.ts` (split in B5) | 1086 | 4 | done |
| 27 | `voice-resolve.ts` + `voice-status.ts` (split in A6) | 762 | 2 | done |
| 28 | `agent-notes.ts` + `note-redact.ts` (split in B8) | 671 | 2 | done |
| 29 | `recall-calendar.ts` + `google-oauth.ts` (split in A7) | 721 | 1 | done |
| 30 | `packages/workspaces-app/test/board-render.test.ts` | 4078 | — | S |
| 31 | `voice-smooth.test.ts` + `voice-smooth-model.test.ts` (split in A8) | 729 | — | done |

The top eight are where the pain is: they carry 991 of the 1350 commits in this
queue. Rows 1 through 8 are worth filing as tickets now; below row 20 a split is
tidiness, and is best done by whoever is already editing the file.

---

## Files with no coverage, and why

A second kind of exception, kept here because it answers the same question the
rest of the page does: *this file breaks a bar, and here is the written reason.*
`bun run coverage` reports a per-package floor, not a per-file one, so nothing
mechanical fails on the rows below — they exist so that a zero in the per-file
listing is a decision on the record rather than an oversight.

One typographic quirk: the first row names its file as `mcp/src/mcp.ts`, with
the `packages/` prefix dropped on purpose. `loc-audit.ts` reads every
`packages/….ts` string anywhere in this document as a size-exception row, and
that file is 400 lines — spelling it in full would report a permanently stale
row at every run. Rows for files that ARE over the limit spell the path
normally.

| File | File lines | Why it has no test |
|---|---|---|
| `mcp/src/mcp.ts` | 400 | The boot file, and the one thing here that genuinely cannot be imported: it ends in `await server.connect(transport)`, so any test that loaded it would start an MCP server on the test runner's stdio and never return. Everything it used to hold has been lifted into modules that take their dependencies as arguments and are covered directly — `http-client`, `channel-messages`, `frame-handler`, `sse-loop`, `watch-registry`, `watch-restore`, `attachments` and `call-tool`, all at **100% line** coverage. Branch coverage across the eight runs 75–100%, lowest on `channel-messages` (75%), whose renderers carry a long tail of `??` fallbacks for fields older servers omit. What is left is construction and wiring: reading identity out of the environment, building the `Server`, and handing each module its collaborators in an order the language enforces. The wiring is asserted end to end instead, by the suites that spawn the shipped bundle as a child process and speak JSON-RPC to it (`packages/mcp/test/review-item-tools.test.ts`, `packages/server/test/mcp-durable-watches.test.ts`). |
| `packages/mcp/src/tool-schemas.ts` | 3245 | Declarative data with no branch in it: the 94-entry `tools/list` result. A test would restate the table. The one property worth asserting — that every advertised name has a dispatch arm — belongs to the dispatcher, not to the table. |
| `packages/mcp/src/tools/docs.ts`, `tools/tasks.ts`, `tools/workspace.ts` | 819 / 1070 / 528 | Not exempt, just not done: these are the three `CallTool` domain families, and the dispatcher that reaches them is now covered while the arms themselves are not. Each arm is a small translation from tool arguments to one REST call, so they are testable the moment someone writes the fakes; the coverage extraction stopped at the dispatcher to keep its diff a pure move. |
