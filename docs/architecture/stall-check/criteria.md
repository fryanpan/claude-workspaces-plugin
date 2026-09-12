# The stall check — module criteria

One block per module: what it must do, what it must never do, and the
measurement that proves it. A module with no measurement is not done. Modules
marked *rebuild* change in the steps named in [README.md](README.md); the
criteria are written for the shape after the rebuild, and a criterion that
today's code fails is flagged.

## `keep-moving.ts` — the classifier

- **Must:** put every open task in exactly one bucket from explicit state
  (status, dependency edges, a filed item's address, a schedule rule), and
  measure quiet time from the newest of status change, board event, thread
  activity and Activity note.
- **Must never:** read prose to decide a bucket. A task's wait is declared
  by the filed item it carries the address of (`waitingOn`), never read out
  of a note (step 2).
- **Measured by:** its unit tests, and the verdict's `unfiled` line reading
  zero on a board where every waiting task carries an item address.

## `stall-gate.ts` — the findings

- **Must:** produce `stalled`, `unfiled` and `undetermined` from the
  classifier, gated on the same quiet window, and name a watched builder's
  silence as `builder-silent`.
- **Must never:** report a task the parallelism cap keeps out of flight, or
  a task under a triage band, or a schedule rule task.
- **Measured by:** unit tests per exclusion; the verdict's `considered`
  denominator.

## `stall-nudge.ts` — the lead wake

- **Must:** send one frame per board to the lead on growth only, remember
  what the lead was told across restarts, re-say an unchanged board at most
  once per repeat window, and fall back to any attached session when the
  lead holds no stream.
- **Must never:** wake on shrink, wake a board whose findings are unchanged
  inside the window, address a session it cannot reach, or get louder about a
  task whose wait somebody else owns. The repeat window is the only clock that
  may re-say a finding, and `clockRows` decides which tasks it speaks for: a
  ticket carrying a held item or a question a reader asked back is named once
  and then not again until that wait's identity changes — a re-hold, a second
  question, or the wait clearing. Before that filter such a ticket woke its
  lead every window with `changed: { escalated: true }` and nothing else. A
  task past the parallelism cap needs no filter: the gate never judges it, and
  `beyondCapacity` is a count on the frame that never enters the stamp.
- **Measured by:** the `[stall] wake` log lines per board per day, and the
  lead's act latency from transcripts (measured 2026-09-08: median 0–4 min).

## `keep-moving-verdict.ts` — the measurement

- **Must:** record one verdict per live board per cadence, off the same
  snapshot the wake reads, persisted so a restart resumes the window; expose
  it on one owner-side route and one log line.
- **Must never:** file anything, wake anybody, appear on a board, or be
  reachable by a share visitor.
- **Measured by:** its own unit tests, and the verdict history itself: a
  gap longer than the cadence on a running server is the module failing.

## `review-judge.ts` — the quality gate

- **Must:** judge every path that puts an ask on a person's queue, hold with
  a reason the filer can act on, admit the third revision regardless, and
  let the reader overrule a hold.
- **Must never:** hold an item the reader could answer in ten seconds for a
  reason of form, or hold a later step of a flow as a repeat of its first.
- **Measured by:** holds per week by reason from the activity log, and the
  false-repeat count (three of sixteen in the week to 2026-09-08, fixed).

## Held items (`stall-gate.ts` `overdueHeldItems`, `stall-nudge.ts` `leadHeldMs`) — *rebuild step 4*

- **Must:** wake the filer once per hold at the store's window (five
  minutes), and count a hold past the QUIET window (twenty minutes) as a
  finding for the lead — in the stall frame's `heldItems` — and a line in the
  verdict, under one window for both. *Passes since step 4:* the wired test
  (`held-item-finding.test.ts`) files a hold, reads the filer's nudge with
  nothing on the lead's stream, waits the hold past the window, and asserts
  the lead's frame and the verdict's `held` line name the same item; its
  control revises a hold away inside the window and asserts neither does.
- **Must never:** let a held ask stand on nobody's queue without the lead
  knowing, or wake the lead over a hold the filer has only just been told
  about.
- **Measured by:** the verdict's `held` line at zero.

## `ui-review-gate.ts` — the UI gate — *rebuild step 5*

- **Must:** name every task that an agent filed, that is in flight, whose
  builder has changed a file a person looks at, and that carries no answered
  review item on either surface — in the lead's stall frame as `ungatedUi` and
  on the verdict's `ungatedUi` line, off the same snapshot, so the frame and
  the measurement cannot name different tasks. Every finding carries the
  changed file it rests on. *Passes since the diff rewrite:* the wired test
  (`ui-gate-finding.test.ts`) files a task as an attached agent, takes it
  in-progress, registers a builder worktree holding a stylesheet edit, and
  asserts the lead's frame and the verdict both name it with that file. Beside
  it sits the widening — a task whose words say nothing about a screen, whose
  builder is editing the stylesheet, and which the gate names anyway — and
  five controls: a task whose builder is editing the server while its own
  words say "button", a task with no registered builder, a builder that
  inherited a finished task's stylesheet, a task with an answered item, and a
  task a person filed.
- **Must never:** name a task a person filed, a task nobody has started, a
  task somebody answered an item on, or a task whose builder has touched no
  screen. A finding here costs a lead turn about work that is going fine, so
  a false positive is the expensive failure and a miss is the cheap one.
- **Measured by:** the verdict's `ungatedUi` line at zero, and — because this
  is the one finding with a judgement in it — the share of findings the lead
  dismisses. A dismissal rate that is not near zero means the file rule is
  wrong, not that leads are ignoring it.

### Why it reads the diff, and what it says when there is none

It used to read the task's title and body against a thirteen-word list.
Measured over two days, that flagged six tasks across three boards and was
wrong all six times:

| # | What matched | Where the word actually came from | The real diff |
| --- | --- | --- | --- |
| 1 | `layout` | the skill name `project-docs-layout` | markdown and version numbers |
| 2 | `button` | a sentence saying which board control filed the task | the server's idle clock |
| 3 | `panel` | a market-research note about respondent panels | no code at all |
| 4, 5 | one pass flagged 2 and a second task together | — | neither had a UI diff |
| 6 | `layout` | the same skill name as 1, on the same task as 5 | already merged and deployed |

Case 6 is the one that settled it: the same task, the same token, six windows
later, after its UI-relevant work had shipped. There was no build left to
hold. The cost is not the lead-minutes. It is that a flag which is usually
wrong stops being read, and the one real ungated UI task then arrives in the
same list as the noise.

So the question is asked of the WORK. A task in flight with a registered
dispatch has a worktree; `changedFilesInWorktree` (`git-diff.ts`) lists what
that worktree has changed since the merge base with the default branch,
committed and uncommitted alike; and a changed-file list answers "does this
touch a screen" as a fact. The rule over one path, in `isUiFile`:

1. a file under a `test`/`tests`/`__tests__`/`spec`/`fixtures` directory, or
   named `*.test.*` / `*.spec.*`, is never a screen — this comes first, and
   without it rule 3 reads a client package's own test suite as UI work;
2. an extension that exists only to be seen — `.css`, `.scss`, `.sass`,
   `.less`, `.html`, `.htm`, `.svg`, `.tsx`, `.jsx`, `.vue`, `.svelte` — is;
3. so is a plain source file under a directory named for a client surface
   (`ui`, `client`, `frontend`, `web`, `components`, `views`, `pages`,
   `styles`, `public`, `static`, `templates`, `widget`) or under one whose
   name ends `-app`, `-ui`, `-web`, `-client` or `-frontend`.

Rule 3 is the weak one — a `.ts` file says nothing about itself — which is
why every finding names the file that convicted it. Measured against this
repo's own client packages over its last 300 merged commits, the three rules
agreed with "did this commit touch `workspaces-app/src` or `widget/src`" on
300 of 300. That is a check of the rules against ONE layout, not proof they
travel; a repo that keeps its screens somewhere else reads as no UI change,
which is the cheap direction.

**A rename is evidence at both ends.** `changedFilesInWorktree` reports a
renamed file under its old path as well as its new one, because moving a
screen out of the client tree is a change to something a person looks at and
a list holding only the destination says the opposite. Rules 2 and 3 both
read a path, so a `.tsx` moved to a `.ts` under `server/src` would otherwise
be the one shape of UI work that hides by leaving.

**The trunk is the closest one, not the one `origin/HEAD` names.** That ref
is written at clone time and git never refreshes it, so a repo that renamed
`master` to `main` and kept the old branch would hand a builder a trunk it
left long ago — and every file anybody has landed on the real one since would
read as this builder's work. `defaultBaseRef` resolves each candidate and
keeps the one whose merge base with HEAD is furthest forward.

**A worktree outlives a dispatch, so the read starts from a baseline.** The
dispatch registry records the commit a checkout was sitting on when the
dispatch was registered (`baseCommit`), and `changedFilesInWorktree` reads
from there when it is both a descendant of the default-branch merge base and
an ancestor of HEAD. Without it, a worktree handed to a second task carries
the first task's commits, and the second row is convicted on a stylesheet
somebody else wrote — the same false positive in a new spelling. A dispatch
with no baseline (a path git cannot answer for, a record persisted before the
field existed) falls back to the merge base; the reader degrades, it never
refuses.

**And when there is no diff, the gate says nothing.** No registered dispatch,
a worktree that has gone, a directory that is not a repo: the changed-file
read answers "cannot tell", and the task goes unjudged. Two alternatives were
weighed and rejected:

- *Keep matching the prose in that window.* This is the behaviour with the
  0-for-6 record, kept for exactly the tasks that have no work to judge.
- *Say "possibly UI" once per task instead of every wake.* This cuts the
  volume by about six but keeps all of the precision problem, and the volume
  was never the complaint — case 6 was one sentence in one frame.

What silence costs is a task whose builder nobody registered: a real breach
there is now missed. That is the accepted direction (a miss is the cheap
failure), and it is not the direction the fix pushes on its own — the diff
read also catches the miss the word list could never catch by construction:

- **A task that changes a screen without saying so.** "Agent can see why a
  task is blocked" matches no word and, if its builder is editing
  `board.css`, is now a finding. This was the *common* miss and is gone.

Three misses remain, written down rather than hidden:

1. **A task whose filer never attached.** "Filed by an agent" is answered by
   the roster, and a name it cannot place reads as not-an-agent — the safe
   direction, since guessing from a name is how a person's task becomes an
   agent's.
2. **A task that shipped before anybody looked.** The check names a task in
   flight; a task taken and finished between two ticks is never seen.
3. **A task being built somewhere the board cannot see** — no dispatch
   registered, or a builder working outside its worktree.
4. **A screen this repo renders from the server.** `shells.ts` and
   `widget-auth-page.ts` carry no UI extension and sit under no client
   directory, so rules 2 and 3 both read them as server code. Measured over
   the same 300 commits, four changed one of them and no client file at all.
   The rule is about path shape and stays that way: hard-coding one repo's
   file names into it would buy this repo four findings and every other repo
   nothing.

The prose match survives as colour. A finding carries the word from the
task's own words when there is one, beside the file, because the lead who
could dismiss a false positive in a second was the lead who had been told
which token matched — and the two together say more than either alone: the
file is what the builder did, the word is what the task claimed to be about.

## `stall-escalation.ts` — the last resort — *rebuild step 3*

- **Must:** file past the lead only when no session on the board is alive:
  no board write and no heartbeat inside the window. Address Team Lead
  first, the owner only when Team Lead is unreachable too. Withdraw the
  moment a session is alive again.
- **Must never:** file about a task that is waiting on the owner with an item
  filed, file while any session on the board is alive, hide its own anchor
  task from the check, or keep an item open on a settle or cooldown after the
  board has come back. *Passes since step 3* — the trigger is liveness alone
  (`boardDeadFor`), a waiting task is not on the lists it reads, the wiring
  skips the board's own item and its own writes when it reads the anchor,
  and the item withdraws on the first tick a session is alive. Before it:
  the trigger was "told and quiet an hour", true of a live lead's tasks
  waiting on the owner 22 times out of 27 on the measured board.
- **Measured by:** the verdict's `escalated` line at zero on every board for
  a week, plus one dead-lead drill per release that reaches Team Lead
  (`dead-board-escalation.test.ts` is the drill in CI: a board with no
  session and a Team Lead on another board gets the frame there and files
  nothing; with nobody reachable it files one item as the server).

## `note-ask.ts` + `note-ask-judge.ts` — *removed in step 2*

- Gone, with the `waiting-on-you` prompt. A task's waiting state is
  declared, so there is nothing to read. The measurement that stands in
  its place is the verdict's `waiting` line: every excused task names the
  item excusing it, so a wait with no address cannot exist.
