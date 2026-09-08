# The stall check — module criteria

One block per module: what it must do, what it must never do, and the
measurement that proves it. A module with no measurement is not done. Rows
marked *rebuild* change in the steps named in [README.md](README.md); the
criteria are written for the shape after the rebuild, and a criterion that
today's code fails is flagged.

## `keep-moving.ts` — the classifier

- **Must:** put every open row in exactly one bucket from explicit state
  (status, dependency edges, a filed item's address, a schedule rule), and
  measure quiet time from the newest of status change, board event, thread
  activity and Activity note.
- **Must never:** read prose to decide a bucket. A row's wait is declared
  by the filed item it carries the address of (`waitingOn`), never read out
  of a note (step 2).
- **Measured by:** its unit tests, and the verdict's `unfiled` line reading
  zero on a board where every waiting row carries an item address.

## `stall-gate.ts` — the findings

- **Must:** produce `stalled`, `unfiled` and `undetermined` from the
  classifier, gated on the same quiet window, and name a watched builder's
  silence as `builder-silent`.
- **Must never:** report a row the parallelism cap keeps out of flight, or
  a row under a triage band, or a schedule rule row.
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

## Held items (`stall-gate.ts` `overdueHeldItems`) — *rebuild step 4*

- **Must:** wake the filer once per hold, and count a hold past the window
  as a finding for the lead and a line in the verdict.
- **Must never:** let a held ask stand on nobody's queue without the lead
  knowing.
- **Measured by:** the verdict's `held` line at zero.

## `stall-escalation.ts` — the last resort — *rebuild step 3*

- **Must:** file past the lead only when no session on the board is alive:
  no board write and no heartbeat inside the window. Address Team Lead
  first, the owner only when Team Lead is unreachable too. Withdraw the
  moment a session is alive again.
- **Must never:** file about a row that is waiting on the owner with an item
  filed, file while any session on the board is alive, hide its own anchor
  row from the check, or keep an item open on a settle or cooldown after the
  board has come back. *Passes since step 3* — the trigger is liveness alone
  (`boardDeadFor`), a waiting row is not on the lists it reads, the wiring
  skips the board's own item and its own writes when it reads the anchor,
  and the item withdraws on the first tick a session is alive. Before it:
  the trigger was "told and quiet an hour", true of a live lead's rows
  waiting on the owner 22 times out of 27 on the measured board.
- **Measured by:** the verdict's `escalated` line at zero on every board for
  a week, plus one dead-lead drill per release that reaches Team Lead
  (`dead-board-escalation.test.ts` is the drill in CI: a board with no
  session and a Team Lead on another board gets the frame there and files
  nothing; with nobody reachable it files one item as the server).

## `note-ask.ts` + `note-ask-judge.ts` — *removed in step 2*

- Gone, with the `waiting-on-you` prompt. A row's waiting state is
  declared, so there is nothing to read. The measurement that stands in
  its place is the verdict's `waiting` line: every excused row names the
  item excusing it, so a wait with no address cannot exist.
