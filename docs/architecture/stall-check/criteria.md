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
  inside the window, or address a session it cannot reach.
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
  words read as UI work, and that carries no answered review item on either
  surface — in the lead's stall frame as `ungatedUi` and on the verdict's
  `ungatedUi` line, off the same snapshot, so the frame and the measurement
  cannot name different tasks. *Passes since step 5:* the wired test
  (`ui-gate-finding.test.ts`) files a UI task as an attached agent, takes it
  in-progress, and asserts the lead's frame and the verdict both name it with
  the word that matched; its three controls are the same task with an answered
  item, the same task filed by a person, and a task with no UI words.
- **Must never:** name a task a person filed, a task nobody has started, a task
  somebody answered an item on, or a task whose words say nothing about a
  screen. A finding here costs a lead turn about work that is going fine, so
  a false positive is the expensive failure and a miss is the cheap one.
- **Measured by:** the verdict's `ungatedUi` line at zero, and — because this
  is the one finding with a judgement in it — the share of findings the lead
  dismisses. A dismissal rate that is not near zero means the keyword set is
  wrong, not that leads are ignoring it.

### The heuristic, and what it cannot see

Three of the four reads are explicit state the store holds: the roster
answers whether the filer is an agent, the task's transitions answer whether
anybody started it, and the two review-item surfaces answer whether anybody
was asked and answered. The fourth — "is this a UI change" — is read out of
the task's title and body against a thirteen-word list (button, screen, page,
layout, mockup, UI, CSS, tap, banner, indicator, badge, panel, float), whole
words, case folded, with a plural or gerund counting as the same word.

Nothing on a task declares which surface it touches, so there is no honest
alternative to reading the prose. Four things this therefore misses, written
down rather than hidden:

1. **A task that changes a screen without saying so.** "Agent can see why a
   task is blocked" is a UI change and matches nothing. This is the common
   miss and it is accepted: the board catches nothing at all today.
2. **A task whose filer never attached.** "Filed by an agent" is answered by
   the roster, and a name it cannot place reads as not-an-agent — the safe
   direction, since guessing from a name is how a person's task becomes an
   agent's.
3. **A task that shipped before anybody looked.** The check names a task in
   flight; a task taken and finished between two ticks is never seen.
4. **The words "design", "view", "render", "style" and "component"**, each
   left out because it is at least as common in server prose here as in UI
   prose, and a finding people learn to dismiss is worse than none.

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
