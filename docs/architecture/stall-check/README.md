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
| No session on the board is alive | Team Lead, then the owner | The last resort — the board files an item past the lead |

The owner is the addressee of exactly one row of that table, and only when
Team Lead cannot be reached either. A row waiting on the owner with a filed
item is already on their queue and is never re-announced.

## The rebuild, in order

Approved 2026-09-08, each step one PR, no stopgaps.

1. **Measurement is internal** (`keep-moving-verdict.ts`, this PR). A verdict
   per board on a fixed cadence, off the same snapshot the wake reads,
   persisted, read from `GET /workspaces/<id>/keep-moving` and the log.
   Appears on no board. The box cron it replaced posted 404s for nine days
   before anyone noticed.
2. **"Waiting on a person" is declared, not inferred.** A row waiting on a
   person carries the address of its filed item, wherever it was filed. The
   note reader (`note-ask.ts`) and its Haiku confirmation are removed.
3. **Escalation is on liveness only.** The board files past the lead when no
   session on the board is alive — no board write and no heartbeat in the
   window — to Team Lead first. The anchor mask, settle and cooldown go with
   the trigger.
4. **A hold cannot become a silent ask.** A held item past the window is a
   finding for the lead and a line in the verdict.

## How to read the verdict

`GET /workspaces/<id>/keep-moving` returns the latest verdict and a week of
history. Each verdict is PASS or FAIL with the rows behind it: `stalled`,
`unfiled`, `unreadable`, `held` (items past the window) and `escalated` (items
the board filed to the owner in the last day). The target is PASS on every
run and `escalated` at zero. The log line is
`[keep-moving] ws=<id> verdict=PASS|FAIL …` with the same counts.
`CW_KEEP_MOVING_HOURS` sets the cadence; the default is four.
