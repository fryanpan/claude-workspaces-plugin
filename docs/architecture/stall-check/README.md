# The stall check — design

**Goal:** every open task on every board is either moving, or its blocker is
named where the person it waits on can answer it, and nobody has to poke to
find out.

This folder is the design and the criteria. The mechanics as they run today
are in [../stall-detection.md](../stall-detection.md), which grew one layer
at a time from 2026-08-27 and is the record of why each exists; this page is
the shape the rebuild of 2026-09-08 holds it to. Per-module criteria, one
block each, are in [criteria.md](criteria.md).

## What "working" means

Three conditions, checked on every task, every tick. Anything in the stall
check that serves none of them is weight.

1. **No silent stall.** A task quiet longer than the window either has a
   filed ask on the person it waits for, or its lead has been told and is
   acting.
2. **No noise to a person.** The owner is only ever shown something they can
   act on: an ask filed by an agent, with options, on their queue. Nothing
   else reaches them from this system.
3. **Bounded cost.** A lead wake is a whole session turn. Wakes happen on new
   information only.

## Who is told what

| Finding | Who hears it | How |
| --- | --- | --- |
| A task is quiet with nobody on it, or its builder stopped reporting | The lead | One frame per board on the stall tick, on growth only |
| A task waits on a person and nothing is filed on that person's queue | The lead | Same frame, `unfiled` |
| An agent's own closing note says it is waiting on a person, with nothing filed on that person's queue | The lead | Same frame, `unfiled`, bucket `waiting-unfiled` — the note also loses its movement credit, so the task's clock never stopped |
| Either of those still unfiled a window later | Team Lead, then the owner | ONE fleet-wide frame, then ONE review item naming every such task across every board — each line saying which of the two it is, because the evidence differs and the reader would correct a line that claimed the wrong one. The frame carries any one row at most `FLEET_TELL_CAP` times, counting only frames that were delivered; past that the row moves onto the owner's item — a record, not a wake — and stays on the lead's line above it |
| A review item is held past the window | Its filer, then the lead | The filer's own wake; then the frame |
| A person asked a question on a review item and its filer has not revised it past the window — it is off their queue, and a reply on the thread does not bring it back | The lead | Same frame, `askedBack`, with the question's age and the `revise_review_item` call |
| An agent-filed UI task is being built with no answered review item | The lead | Same frame, `ungatedUi` |
| A task's blockage LIFTED — an ask on it answered, or a done-when line met with later lines still open — and nothing has touched it since | The lead | Same frame, `unresumed`, each row naming the lift and its timestamp. Gated on the same quiet window as every other finding, measured FROM THE LIFT: an answer a minute old is one somebody may be reading |
| An in-progress task has every line met except those written as needing a person (`needs: 'owner'`), and its builder has not reported one of them ready | The task's agent, else the lead | `workspace.done_when_ready`, one per such line, once while it stands (`review-items/done-when-ready.ts`) — never the person, who is asked only once the builder reports the line `owner` |
| No session on the board is alive | Team Lead, then the owner | The last resort — the board files an item past the lead |

The owner is the addressee of exactly two lines of that table, and each only
when Team Lead cannot be reached either. Both of those lines file ONE item,
not one per task: a fleet-wide problem that arrives as eleven separate cards
is a fleet-wide problem nobody reads. A task waiting on the owner with a filed
item is already on their queue and is never re-announced.

Every line of that table is said again while it stands: the board's repeat
window is what makes a board nobody is driving get louder. It gets louder only
about work the lead can move. A ticket whose review item is held, or whose
reader asked a question back, is quiet for a reason that belongs to its filer,
so it is named once and then stops driving that clock (`clockRows` in
`stall-nudge.ts`) until the wait's identity changes — the item held again, a
second question, or the wait cleared. A task with a standing `declare_wait`
is not a finding at all (`withoutStandingWaits`): it wakes nobody, is never
listed as stopped, and rides along on a wake that fired for something else
only as a declared wait. The tick after the wait lapses it is a finding again,
carrying all its silence. A task past the parallelism cap is not judged for
STALLING — there was no slot for it, so its silence is idleness by rule and it
never enters the clock. It is still judged for an unanswered ask: capacity is
why nobody picked the row up and says nothing about a question already asked
and filed nowhere.

## The rebuild, in order

Approved 2026-09-08, each step one PR, no stopgaps.

1. **Measurement is internal** (`keep-moving-verdict.ts`, PR 801). A verdict
   per board on a fixed cadence, off the same snapshot the wake reads,
   persisted, read from `GET /workspaces/<id>/keep-moving` and the log.
   Appears on no board. The box cron it replaced posted 404s for nine days
   before anyone noticed.
2. **"Waiting on a person" is declared, not inferred** (PR 802). A task
   waiting on a person carries the address of every filed item excusing it —
   a ticket item, or a comment-borne item on the ticket's thread or a doc
   the task links — and whether an item still excuses the task is the Home
   queue's own predicate (`isReviewItemOnQueue`, `pendingDeclaration`), so a
   held, answered, withdrawn or reader-asked-back item excuses nothing. A
   note saying "waiting on Bryan" with nothing filed sets no bucket at all.
   The note reader (`note-ask.ts`), its Haiku confirmation and the
   `waiting-on-you` prompt are gone; the snapshot and the verdict carry a
   `waiting` list so every excused wait is traceable to its item.
   **Amended by step 6**, which does not reverse this: a wait is still never
   inferred to EXCUSE a task, but an unfiled one no longer excuses the clock
   either.
3. **Escalation is on liveness only** (PR 803). A board is dead when no
   session on it is deliverable — no stream open, nobody observed inside the
   delivery window — and none has written to it or heartbeated on it for the
   escalation window (an hour). Only then does it go past its lead: its own
   stall frame to Team Lead, on whichever board Team Lead holds a stream,
   once per window while it stays dead; and a review item on the reader's
   queue only when Team Lead is unreachable too. A live lead's tasks never
   escalate, however stuck — the wake is their addressee. A task waiting on a
   person with the ask filed is not a finding, so it is never in the item.
   The told clock, the undeliverable clock, the anchor mask, the settle
   window and the re-file cooldown are gone with the trigger: the item is
   withdrawn the tick a session is on the board again, and the board's own
   writes on its anchor task do not count as the task moving.
4. **A hold cannot become a silent ask** (this PR). A held review item has
   two windows, and they belong to two people. At five minutes
   (`CW_HELD_ITEM_MINUTES`) the FILER is told, once per hold — the filer can
   end it in one call, so the tap goes to them first and to nobody else. At
   the quiet window (`CW_STALL_NUDGE_MINUTES`, thirty minutes) a hold still
   standing is the LEAD's finding: it is named in the lead's stall frame as
   `heldItems`, it arms the board's stamp, and it is counted on the verdict's
   `held` line — one window for the frame and the measurement, so the lead
   cannot be woken about a hold the verdict omits, and the verdict cannot
   fail on one the lead was never told of. Before this step the lead heard
   of every hold at the filer's five minutes, fifteen minutes before the
   verdict counted it, which was the same wake said twice with a different
   number on each. A hold revised away inside the window never reaches the
   lead at all.
5. **A UI change an agent proposed cannot ship unasked** (this PR). An
   agent-filed task that changes what a person sees on screen clears a review
   item — answered — before anybody builds it. That is the complex-task gate
   the two board skills already carry; what is new is that a breach is
   VISIBLE. A task an agent filed, in flight, whose BUILDER has changed a
   file a person looks at (`ui-review-gate.ts`), with no answered review item
   on either of its two surfaces, is named in the lead's stall frame as
   `ungatedUi` and counted on the verdict's `ungatedUi` line. It is the only
   finding here about a task that IS moving, which is the point: the rule it
   breaks is about what got skipped on the way, and every other check on this
   board is a check for silence. All four of its reads are explicit state —
   the roster, the transitions, the builder's changed-file list and the two
   review-item surfaces. It used to read the task's own words for the third
   of those, and was wrong six times out of six; the story, and why the check
   now says nothing at all about a task with no diff to read, are in
   [criteria.md](criteria.md).
6. **An unfiled wait cannot excuse the clock** (this PR). Step 2 made a wait
   something a task DECLARES; it left a hole in the other direction, because
   a note still counted as movement whatever it said. An agent that closed
   every turn with "waiting on <person>" and filed nothing reset its own
   task's clock forever, and the task never stalled. Now a note whose words
   ask a person, with nothing filed on that person's queue, loses its
   movement credit on both paths into the clock (`task.notes` and the
   `updatedAt` the note's own append stamps), and past the quiet window the
   task is named in the lead's frame on the `unfiled` list under its own
   bucket, `waiting-unfiled`. This sets no bucket from prose and parks
   nothing: the only thing a wrong reading can cost is one line in a frame
   the lead was already getting. Still unfiled a window later, it goes up the
   existing ladder — Team Lead first as ONE fleet-wide frame, the owner's
   queue only if Team Lead is unreachable, and then as ONE review item naming
   every such task across every board. The judgement of "this asks" is
   `detectAsk`, the filing nudge's own reader, re-measured over three days of
   real closing notes when this shipped (`unfiled-ask.md`).

   **That ladder is the `unfiled` list's, not this bucket's** (corrected
   2026-09-17). It was built reading `waiting-unfiled` alone, which left the
   older way onto the same list — `blocked-on-owner-unfiled`, where the BOARD
   says a person owns the task and nothing is on that person's queue — with
   no aging path at all: the only other filer is step 3's, and that fires only
   when no session on the board is alive, so a board-declared unfiled ask on a
   LIVE board was told to its lead every repeat window and went past nobody.
   One remedy, one list, one ladder. The item names each task for the evidence
   it has, because a line telling the reader an agent wrote closing words it
   never wrote is a line they would correct.

## How to read the verdict

`GET /workspaces/<id>/keep-moving` returns the latest verdict and a week of
history. Each verdict is PASS or FAIL with the tasks behind it: `stalled`,
`unfiled`, `unreadable`, `held` (items past the window), `escalated` (items
the board filed to the owner in the last day) and `ungatedUi` (tasks built past
the UI gate), plus `waiting` — the tasks a
filed item excuses, each with the item's address — which is a record rather
than a finding. The target is PASS on every
run and `escalated` at zero. The log line is
`[keep-moving] ws=<id> verdict=PASS|FAIL …` with the same counts.
`CW_KEEP_MOVING_HOURS` sets the cadence; the default is four.
