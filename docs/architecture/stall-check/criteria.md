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

## `owner-ask.ts` — is a person owed an answer

- **Must:** answer from explicit state alone — a filed item, the board's
  ownership, the band, and the date of the row's own schedule rule — and
  distinguish "the ask is on their queue" from "it exists only in somebody's
  head" from "nobody is waiting at all".
- **Must never:** read a bucket, or read prose. And never call a row an
  unfiled ask because its rule is dated in the future: the work has not
  started, so nobody has been asked anything yet. That reading shipped for a
  day in September 2026 and named six future-dated rows on one board,
  one of them deferred by its owner in as many words.
- **Measured by:** its unit cases in `scheduled-row-asks.test.ts`, each
  paired with the same row carrying no rule, so "a rule row's ask reads
  exactly like any other row's" is asserted rather than assumed.

## `stall-gate.ts` — the findings

- **Must:** produce `stalled`, `unfiled` and `undetermined` from the
  classifier, gated on the same quiet window, and name a watched builder's
  silence as `builder-silent`.
- **Must:** keep a task the BOARD says a person owns, with nothing on that
  person's queue, OFF every finding list — it goes on `awaitingPerson`, a
  record that counts toward no FAIL, reaches no frame and reaches no review
  item. Nobody has an act to perform on such a row: an agent cannot hand it
  back, and the person already holds it. It was on `unfiled` until
  2026-09-22, and one row reached the owner on three review items in five
  days that way (Bryan, 2026-09-21: *“The first one is assigned to me
  already. Work with workspaces to stop alerting me.”*).
- **Must never:** report as STALLED a task the parallelism cap keeps out of
  flight, report at all a task under a triage band, or report a schedule rule
  task AS WORK. The three are not one shape. A triage-band row is dropped in
  `keep-moving.ts` before any bucket is decided, so it reaches no list here at
  all. A capped row is classified like every other and only its stall reading
  is withheld — it still reaches the `unfiled` list, because an unanswered
  question is a finding whatever the capacity; the cap held one anyway until
  2026-09-17, when it skipped the row outright and `waiting-unfiled` rides
  runnable buckets the cap is built from. And a rule row's own unanswered ask
  is a different finding from the rule, so it is reported (#1077) — unless the
  rule's date has not arrived, which is a deferral rather than a question
  (`owner-ask.ts`, above).
- **Consequence:** a `declare_wait` on a person-owned row now annotates
  nothing. `declaredWaits` is built from the rows the gate reports, and such a
  row is on neither, so there is no frame line for the declaration to change.
  Nothing is lost — the declaration exists to say why a FINDING is quiet, and
  this row is no longer one.
- **Measured by:** unit tests per exclusion, including a `waiting-unfiled` row
  ranked past the cap (`waiting-unfiled-beyond-cap.test.ts`); the verdict's
  `considered` denominator; `person-owned-quiet.test.ts` for the record,
  which drives all five surfaces with the agent-declared bucket as its
  control on each; `task-wait.test.ts` for the declaration.

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
  task with a standing declared wait is taken off `stalled` before any of
  this (`withoutStandingWaits`), so it neither wakes the lead nor appears
  under "stopped moving" on a wake something else caused, until it lapses. A
  task past the parallelism cap needs no filter for its SILENCE: the gate
  never judges that, and `beyondCapacity` is a count on the frame that never
  enters the stamp. An unfiled ask on such a task does reach the frame, and
  should — it is one call for the lead, and no slot is needed to make it.
- **Measured by:** the `[stall] wake` log lines per board per day, and the
  lead's act latency from transcripts (measured 2026-09-08: median 0–4 min).

## `review-items/done-when-ready.ts` — the ready reminder

- **Must:** tell the task's agent (else the board's lead) once, on the stall
  tick, when an in-progress task has every line met but one written as
  needing a person that has not been reported `owner`; record the line as
  told only once a stream took the frame; forget it when it stops waiting, so
  a person's Not met sending it back is told afresh.
- **Must never:** put anything on the person's queue, fire while an ordinary
  line is still open, or re-send on every tick.
- **Measured by:** `done-when-ready.test.ts` and
  `done-when-needs-owner.test.ts`. The told set is in memory, so a restart
  can re-send at most one frame per waiting line.

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
  six controls: a task whose builder is editing the server while its own
  words say "button", a task with no registered builder, a builder that
  inherited a finished task's stylesheet, two tasks sharing one checkout, a
  task with an answered item, and a task a person filed.
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

**A degraded read says it is one.** The read returns which base it used
(`from: 'dispatch' | 'trunk'`), and the finding line carries it: `changed
since dispatch commit: <file>` is this task's work (less any edits left
uncommitted before the dispatch, which no commit can pin), while `changed since trunk merge
base, cannot tell this task's work from other work: <file>` is everything
committed in that checkout since it left trunk, and the sentence names the
worktree rather than the builder. A reader who cannot tell the two apart pays
the investigation the gate exists to save.

**Two live dispatches in one checkout are ambiguous, and ambiguous evidence
is no evidence.** The registry does not stop a lead putting two tasks in one
worktree, and nothing in a diff says which task an edit was for — naming both
would be two findings off one stylesheet with at least one of them wrong. The
reader drops every task whose worktree another open dispatch also names, so
both go unjudged.

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

## `blockage-lift.ts` — the lifted blockage

- **Must:** name every task whose blockage LIFTED and which nothing has
  touched since — in the lead's stall frame as `unresumed` and on the
  verdict's `unresumed` line, off the same snapshot, so the frame and the
  measurement cannot name different tasks. Two lift signals, both explicit
  state: a review item on the task was ANSWERED (on either surface — a
  ticket-borne item's `answer`, a comment-borne payload's `answeredAt`), and
  a done-when line moved to `met` while a LATER line is still open. Every
  finding carries the lift's kind, its timestamp and the line or headline it
  rests on, the way `ungatedUi` carries the file that convicted a row: a
  finding that fires once at a boundary and never again is indistinguishable
  from a real one unless it names what it rests on. The reading is gated on
  the board's own quiet window measured FROM THE LIFT, and on the classifier's
  existing `sinceActivityMs` — the newest of status change, board event,
  thread activity and Activity note.
- **Must never:** read prose; add a second clock; name a task whose LAST open
  line just went met — completion is not a resumed blockage, and naming it
  would turn the moment a ticket finishes into a wake; name a task whose
  agent declared a wait AT OR AFTER the lift and whose declaration is still
  standing — the finding's whole sentence is that nobody has recorded reading
  the answer, and that declaration is the record (a wait declared BEFORE the
  lift, or one that has lapsed, says nothing about it and still names the
  task); or name a task the
  board has recorded any activity on since the lift. That last one is the
  load-bearing guard, not the window: a task answered on Monday, worked all
  week and quiet for forty minutes is not this finding, and a reading that
  names it has rebuilt the status-age reading that called a merged, deployed
  task parked for 44.6 hours.
- **Measured by:** the wired test (`resumed-work-finding.test.ts`), which
  files an ask on a quiet in-progress task, answers it, and asserts the lead's
  frame and the verdict both name the task with the answer's own timestamp;
  the same for a first done-when line going met with the remainder open. Beside
  them sit three controls, each differing from a positive by exactly ONE
  input — the connector timeline (the same answer, plus one note stamped clear
  of `LIFT_CLOCK_EPSILON_MS` after it), completion (every line met rather than
  the first), and the last line going met while earlier lines are open, which
  isolates the rule from the auto-close that would carry the previous control
  on its own. Each control rides a BEACON row that is quiet and on no lift, so
  a silence assertion proves the tick ran rather than that no frame arrived.
  The unit cases are `blockage-lift.test.ts`, and the declared-wait rule's
  are the last describe of `stall-declared-wait.test.ts` — the wait declared
  after the lift, the one declared before it, the one that has lapsed, and the
  same row with no wait at all. And on the board itself: the
  verdict's `unresumed` line at zero, and the finding naming a PROPER SUBSET
  of the tasks that merely carry a met line with later lines open — naming all
  of them is the status-age reading again.

### Why the lift is never a finding on its own

The failure it was built for, measured: a task declared a wait on a person for
two values, the person answered the item that asked for them, the board
recorded the answer, and nothing treated it as an event. The work sat
unblocked for 21 hours while the board still read as blocked. Every step of
the queue worked — the ask was filed, it was answered, the answer was
stored — and the one thing missing was anybody reading the answer as the
moment the work could start again.

On the same board, the same evening, a second task carried an answered item
AND an open done-when line and was working perfectly: a plan posted at
12:21:28Z, its first report at 13:53:30Z, the done-when line marked met at
13:54:31Z quoting that report. **Sixty-one seconds from the answer to the
line.** From the outside those two tasks carry the same two facts in the same
order.

So the reading asks two things of a lift, and both are about the task's own
activity clock rather than about the lift's existence: the lift is older than
the quiet window, and NOTHING has touched the task since it. The connector
task fails both, and would fail the second with no window at all — which is
the property that matters. The window is the cheap guard; the activity read is
the load-bearing one.

`LIFT_CLOCK_EPSILON_MS` is the one tolerance, and it exists because the lift's
own write is itself activity: answering an item stamps the row, and so does
reporting a line, so with no tolerance the newest activity would always be
at-or-after every lift and the finding could never fire. It is 250ms —
MEASURED rather than assumed, against a real server on 2026-09-17, where both
writes are stamped from one clock read inside the handling request and the gap
read **0 ms** on both paths. It is deliberately not `EVENT_TICK_EPSILON_MS`'s
five seconds: that number covers a note carrying the POSTER's clock across the
network, and every millisecond of this one is a millisecond in which real work
would be mistaken for the lift's own write.

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

## `waiting-unfiled-escalation.ts` — the aging half — *rebuild step 6*

- **Must:** age EVERY task on the gate's `unfiled` list — one bucket,
  `waiting-unfiled`, since 2026-09-22 — and past a second window address
  Team Lead first as ONE fleet-wide frame, the owner only when Team Lead is
  unreachable or the row has spent its wakes, and then as ONE review item PER
  BOARD, filed on that board and naming only that board's tasks.
- **Must never:** name a `blocked-on-owner-unfiled` row anywhere. It is not a
  finding (`stall-gate.ts`, above), and this module is the last gate before a
  person's queue, so it refuses the bucket itself rather than trusting the
  list it is handed.
- **Must never:** put a row from one board on another board's item. One item
  naming rows across boards gives its reader lines they cannot act on (Bryan,
  2026-09-21: *“The second isn't even in your project”*). The WAKE is still
  one frame for the whole fleet, because a wake is a turn and the fact is the
  same fact; an item is a record on a queue, and a queue belongs to a board.
- **Must:** carry any one task in at most `FLEET_TELL_CAP` fleet frames, and
  count a frame against a task only when the send actually DELIVERED. A task
  past the cap moves to the owner's standing item — a record, not a wake —
  and stays on the gate's `unfiled` list, which is where the board's own lead
  keeps seeing it. Its count is dropped with its `firstSeen`, so a task that
  moves and asks again is carried again.
- **Must never:** file a second item on a refusal, ask the owner again about a
  task they have already answered or withdrawn, file while Team Lead can be
  reached AND every due task still has wakes left, or spend a task's wake on a
  frame that reached nobody. A task that stops being a finding is forgotten
  and its item withdrawn on that tick.
- **Measured by:** `waiting-unfiled-escalation.test.ts`, with the one-window
  control beside the two-window case, the two-board case asserting each
  board's item names only its own rows, and the case where one board's item
  is withdrawn while the other's stands; `person-owned-quiet.test.ts` for the
  refused bucket, with its filing control; `waiting-unfiled-fleet-quiet.test.ts` for the cap, its
  `fleetTellCap: 99` control, the move to the owner's item and the
  undelivered-send case; `waiting-unfiled-sidecar.test.ts` for what a restart
  and a pre-cap file remember. The verdict's `escalated` line cannot measure
  the Team Lead rung: it counts items this actor filed, and a fleet-wide zero
  there says Team Lead was reachable, not that the ladder ran.

## `note-ask.ts` + `note-ask-judge.ts` — *removed in step 2*

- Gone, with the `waiting-on-you` prompt. A task's waiting state is
  declared, so there is nothing to read. The measurement that stands in
  its place is the verdict's `waiting` line: every excused task names the
  item excusing it, so a wait with no address cannot exist.
