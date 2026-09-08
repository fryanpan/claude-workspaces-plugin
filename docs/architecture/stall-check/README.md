# The stall check — design

**Goal:** every open row on every board is either moving, or its blocker is
named where the person it waits on can answer it, and nobody has to poke to
find out.

This folder is the design and the criteria. The mechanics as they run today
are in [../stall-detection.md](../stall-detection.md), which grew one layer
at a time from 2026-08-27 and is the record of why each exists; this page is
the shape the rebuild of 2026-09-08 holds it to. Per-module criteria, one
block each, are in [criteria.md](criteria.md).

## What "working" means

Three conditions, checked on every row, every tick. Anything in the stall
check that serves none of them is weight.

1. **No silent stall.** A row quiet longer than the window either has a
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
| A row is quiet with nobody on it, or its builder stopped reporting | The lead | One frame per board on the stall tick, on growth only |
| A row waits on a person and nothing is filed on that person's queue | The lead | Same frame, `unfiled` |
| A review item is held past the window | Its filer, then the lead | The filer's own wake; then the frame |
| An agent-filed UI row is being built with no answered review item | The lead | Same frame, `ungatedUi` |
| No session on the board is alive | Team Lead, then the owner | The last resort — the board files an item past the lead |

The owner is the addressee of exactly one row of that table, and only when
Team Lead cannot be reached either. A row waiting on the owner with a filed
item is already on their queue and is never re-announced.

## The rebuild, in order

Approved 2026-09-08, each step one PR, no stopgaps.

1. **Measurement is internal** (`keep-moving-verdict.ts`, PR 801). A verdict
   per board on a fixed cadence, off the same snapshot the wake reads,
   persisted, read from `GET /workspaces/<id>/keep-moving` and the log.
   Appears on no board. The box cron it replaced posted 404s for nine days
   before anyone noticed.
2. **"Waiting on a person" is declared, not inferred** (PR 802). A row
   waiting on a person carries the address of every filed item excusing it —
   a ticket item, or a comment-borne item on the ticket's thread or a doc
   the row links — and whether an item still excuses the row is the Home
   queue's own predicate (`isReviewItemOnQueue`, `pendingDeclaration`), so a
   held, answered, withdrawn or reader-asked-back item excuses nothing. A
   note saying "waiting on Bryan" with nothing filed is a plain stall to the
   lead. The note reader (`note-ask.ts`), its Haiku confirmation and the
   `waiting-on-you` prompt are gone; the snapshot and the verdict carry a
   `waiting` list so every excused wait is traceable to its item.
3. **Escalation is on liveness only** (PR 803). A board is dead when no
   session on it is deliverable — no stream open, nobody observed inside the
   delivery window — and none has written to it or heartbeated on it for the
   escalation window (an hour). Only then does it go past its lead: its own
   stall frame to Team Lead, on whichever board Team Lead holds a stream,
   once per window while it stays dead; and a review item on the reader's
   queue only when Team Lead is unreachable too. A live lead's rows never
   escalate, however stuck — the wake is their addressee. A row waiting on a
   person with the ask filed is not a finding, so it is never in the item.
   The told clock, the undeliverable clock, the anchor mask, the settle
   window and the re-file cooldown are gone with the trigger: the item is
   withdrawn the tick a session is on the board again, and the board's own
   writes on its anchor row do not count as the row moving.
4. **A hold cannot become a silent ask** (this PR). A held review item has
   two windows, and they belong to two people. At five minutes
   (`CW_HELD_ITEM_MINUTES`) the FILER is told, once per hold — the filer can
   end it in one call, so the tap goes to them first and to nobody else. At
   the quiet window (`CW_STALL_NUDGE_MINUTES`, twenty minutes) a hold still
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
   agent-filed row that changes what a person sees on screen clears a review
   item — answered — before anybody builds it. That is the complex-task gate
   the two board skills already carry; what is new is that a breach is
   VISIBLE. A row an agent filed, in flight, whose words read as UI work
   (`ui-review-gate.ts`), with no answered review item on either of its two
   surfaces, is named in the lead's stall frame as `ungatedUi` and counted on
   the verdict's `ungatedUi` line. It is the only finding here about a row
   that IS moving, which is the point: the rule it breaks is about what got
   skipped on the way, and every other check on this board is a check for
   silence. Three of its four reads are explicit state; the fourth is a
   keyword read of the row's own words, and its limits are in
   [criteria.md](criteria.md).

## How to read the verdict

`GET /workspaces/<id>/keep-moving` returns the latest verdict and a week of
history. Each verdict is PASS or FAIL with the rows behind it: `stalled`,
`unfiled`, `unreadable`, `held` (items past the window), `escalated` (items
the board filed to the owner in the last day) and `ungatedUi` (rows built past
the UI gate), plus `waiting` — the rows a
filed item excuses, each with the item's address — which is a record rather
than a finding. The target is PASS on every
run and `escalated` at zero. The log line is
`[keep-moving] ws=<id> verdict=PASS|FAIL …` with the same counts.
`CW_KEEP_MOVING_HOURS` sets the cadence; the default is four.
