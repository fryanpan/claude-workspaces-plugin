# Scheduled tasks — the board starting work at its time

A board row can carry a **rule** that says when its work should start. When
the rule comes due the server files the work as an ordinary task and puts it
in front of its owner. Nobody has to be watching a clock, and no session has
to stay awake to be the thing that remembers.

This file is the **product rules** — what a rule means, what happens when the
server was not running, and what a reader on the board is looking at. The
mechanics live in the two modules' own doc comments and are not repeated
here: `packages/core/src/task-schedule.ts` (all the arithmetic, pure) and
`packages/server/src/task-scheduler.ts` (the loop that acts on it).

## A rule row is not the work

The row you write the rule on is the **rule**. It never moves through
statuses, and closing it would be closing the thing that produces the work.
Each time the rule comes due the server creates a separate ordinary task — an
**instance** — and that is the row somebody actually does.

An instance is a real task in every way that matters. It lands in the rule's
own goal band, owned by the rule's owner, filed through the same door as
anything a person files, so it queues, blocks, gets picked up and closes
exactly like its neighbours. What sets it apart is one mark, `recurrenceOf`,
naming the rule it came from and — this is the part a reader needs — **the
occurrence it stands for**, which is not the same as when the row was
created. A catch-up after downtime files a row on Friday for Monday's
occurrence, and the board has to be able to say so.

```mermaid
flowchart LR
  R["Rule row<br/>schedule: every weekday 9am"] -->|"occurrence comes due"| S["The loop<br/>task-scheduler.ts"]
  S --> I["Instance<br/>ordinary task, rule's band and owner<br/>recurrenceOf: rule + occurrence"]
  S --> A["Activity note on the rule row<br/>which occurrence, which instance"]
  S --> C["Cursor advanced on the rule<br/>lastOccurrenceAt"]
```

## The rule shapes

Four kinds, and the split between the first three and the fourth is the one
design decision worth knowing.

| Kind | Means | Next occurrence comes from |
| --- | --- | --- |
| `once` | a one-off at an instant | the instant, and then it is spent |
| `every` | a fixed interval | the arming, plus whole steps |
| `calendar` | times of day, optionally on named weekdays | the local calendar |
| `after-completion` | a delay after the last run finished | the completion |

`every` and `calendar` are **fixed cadence**: the next occurrence comes from
the schedule whether or not the last one was ever done. `after-completion`
is the other mode: a rule whose instance is still open is owed nothing at
all, which is what stops a slow-moving chore stacking up behind itself.

The two fixed-cadence kinds are not one kind because a day is not a fixed
number of milliseconds. `calendar` recomputes the instant from the local wall
clock each day, so nine in the morning stays nine in the morning across a
daylight-saving change; an interval rule meaning "every morning" would be an
hour wrong for half the year. Rules finer than a day are `every`; rules
grained in days are `calendar`. A rule carries its own timezone, because this
board has no workspace-level one to inherit.

Two optional limits apply to any of them: `until`, after which the rule is
owed nothing more, and `armedAt`, which is set when somebody writes the rule
and is the floor for its first occurrence. A rule can never fire for a moment
before it existed.

## Missed runs do not pile up — and the rule says what happens instead

When the server has been down, several occurrences may have come due. The
arithmetic collapses them into **one** occurrence, the latest, carrying a
count of the ones behind it; the cursor advances past all of them so none
fires again tomorrow. What is done with that one occurrence is the rule's
own choice, written as the last clause of its phrase and shown as a chip:

| Policy | Phrase | After an outage |
| --- | --- | --- |
| catch up (default) | *nothing written* | one instance, **flagged as a catch-up** |
| skip | `…, skip if missed` | no instance; the skip is recorded |

An occurrence is *missed* when something later has also come due, or when the
fire would land more than five minutes past its instant — never more than
half an interval for an interval rule. An on-time occurrence is the ordinary
fire whatever the policy says; the policy is about missed work only. An
after-completion rule has no slot to miss, so it takes no clause and no chip.

The catch-up instance is an ordinary row with `catchUp` on its recurrence
mark: the board draws the mark in the accent and its title says how many
occurrences it stands in for. A skip leaves no row, so the record is the rule
row's activity ("Skipped missed occurrence …") and two counters on the rule:
`missedTotal`, every occurrence that got no row of its own, and
`skippedTotal`, the part of that the policy declined.

**The open catch-up row is a lock.** While a catch-up instance is still open,
the next occurrence of a fixed-cadence rule *folds into it* — the cursor
advances, the catch-up's own count grows, the activity says where the
occurrence went, and no second row is filed. The lock is held on the board,
in the row's status, not in any process: closing or archiving the catch-up
releases it, and the next occurrence files as normal. An ordinary open run is
not a lock — fixed cadence stacks by design, and only the row that already
stands in for missed work refuses company. The decision is
`missedRunOutcome` in `packages/core/src/schedule-missed.ts`, pure like the
rest of the arithmetic.

## The run record — prove the run happened, not that it was scheduled

Every peer interviewed for this subsystem had a scheduled job fail silently
for weeks, and all three asked for the same three facts on the row: the last
run, how it ended, and how old that reading is. A schedule that is not firing
looks exactly like one that is until the row carries them.

`packages/core/src/schedule-run-record.ts` derives them, pure, from the
rule's own state and its last instance; the board and the server both call
it, so the row on screen and the item the server files can never disagree.
On the Scheduled row it is one phrase after the next run — `Done 2h ago`,
`Running 3d`, `Never ran`, `Ran 2d ago` for an instance the board no longer
holds — and the rule's activity gets one line per success naming the
instance the work landed in (`Run finished — t-… done, 2h after it
started`), so "where did the output go" is answered by the row's own trail.

**A success is written onto the rule** (`state.lastSuccessAt`) by
`packages/server/src/task-run-record.ts` on the scheduler's pass, the first
tick after the instance closes `done`. The instance is not a durable
witness — it can be reopened, archived, or age off a board — and a record
that forgot a success every time somebody touched the row would be worse
than none.

**Stale.** The last success is older than one interval plus a slack, the
slack being the smaller of one interval and one hour: a daily rule is stale
twenty-five hours after its last success, an hourly one after two hours. A
rule that has never succeeded counts from its arming. A one-off has no
interval and is never stale; a rule past its end limit is finished, not
stale; an after-completion rule's interval is its delay, so an instance
nobody closes goes stale like any other — the failure the peers described.
On the row the word `stale` takes the state slot (blocked and triage outrank
it) and the record turns red.

**Stale files ONE review item, never one per tick.** The server files it on
the rule row as the scheduler's own actor, through the same door the stall
escalation uses, and remembers it on the rule (`state.staleItem`). While
that item is open nothing more is filed. A success withdraws it. Answering
it closes it too, and an answered item is not filed again until the rule
has succeeded and gone stale AGAIN — an item re-filed against the silence
the reader just acknowledged is the log nobody reads, wearing a queue's
clothes.

## The wake path — a filed row is not a started one

Every scheduled row's owner is an agent, and an agent's session is not
always running. So filing the instance is the first half of a run; the
second is getting a session onto it, and that is `task-scheduled-wake.ts`,
on the same pass as the run record. The pure half — the retry schedule,
what one wake records — is `schedule-wake.ts` in `core`, so the board can
read the wake off the rule exactly as the server wrote it.

While the instance sits in `todo`, each pass asks one question: can the
owner be reached? An owner holding a stream on the board gets one addressed
frame, `task.scheduled_run`, carrying the instance id — `sendToAgent`, the
delivery the stall and ready wakes ride, never a broadcast. An owner with no
stream gets nothing it could read; instead the SPAWNER — the one session on
this server that starts others, named by `spawnerAgentId` on
`ServerOptions` (`CW_SPAWNER_AGENT_ID`, default the fleet's Team Lead) and
reached on whichever board it is attached to — gets one
`task.spawn_requested` naming the owner and the row. One per instance: the
spawned session claiming the row is the answer both are waiting for, and a
second ask before the first is acted on is noise. Bryan's words for it
(2026-09-04): *"alert Team Lead to spawn the session just to run one task.
Then spin down."*

**Attempts are bounded, with backoff.** Four: at the fire, then five,
fifteen and forty-five minutes after the previous one. An attempt that
reaches nobody is still an attempt — that is what bounds the run. One more
window after the last, the board stops and files ONE review item on the
instance, the owner's own row, so a person can start the session, hand the
row over, or say it can wait. Every attempt is written on the rule
(`state.wake`, replaced when the next instance is filed), with who it
reached, and the moment the instance leaves `todo` the wake records who
took it. The run record reads that back: an open instance says `Waiting 5m`
while a wake is owed, `Unanswered 2h` in red once the board has given up,
and `Running` only when somebody has it.

## Restart safety

The guarantee is that a rule **neither loses an occurrence nor fires one
twice**, across any number of restarts. Two things make it true.

The cursor records **the occurrence, not the clock**. What is stored is the
instant the fire was *for*, so a catch-up hours late still compares correctly:
an occurrence at or before the cursor is spent forever, and every later one is
still owed. Storing when the server happened to notice would make a late fire
indistinguishable from a fresh one.

The instance and the cursor **land in one write**. Both the rule row and the
instance live in the same workspace sidecar, written whole and renamed into
place. A crash between them is not possible: either both survive, or neither
does and the next boot fires the occurrence it never finished. That is why
the loop advances the cursor the moment the instance exists, and why nothing
in this subsystem needs a journal of its own.

A create the board **refuses** — a stood-down board, a goal band that has
since been deleted — leaves the cursor exactly where it was, so the occurrence
is still owed on the next pass. A refusal is a condition somebody fixes;
swallowing the occurrence would hide it.

## The clock is injected

The loop reads its time from a function, not from `Date.now`, all the way
down: every function in `task-schedule.ts` is a total function of the `now`
it is handed. That is the same seam the stall wake uses, and for a stronger
reason — this feature *is* a comparison against a clock, so a test that could
not move the clock would have to wait until tomorrow to assert that a daily
rule fires tomorrow. `schedulerNow` on `ServerOptions` is where a caller
supplies one.

## A rule is written as a sentence

A rule is set by typing English — "every weekday at 9am" — and read back as
chips you can click. The phrase and the chips are **two views of one rule**
(Bryan, on the approved mock), so neither is the source: the phrase is parsed
into the rule, the chips are drawn from the rule, and editing a chip rewrites
the phrase from the rule it just changed. That is the only arrangement in
which a chip cannot say something the sentence above it does not.

The pair lives beside the arithmetic in `core` —
`schedule-phrase-parse.ts` reads, `schedule-phrase.ts` writes and owns the
vocabulary both the sentence and the chips are spelled in — and the tests
assert they are inverses, and that the canonical spelling is a fixed point.
Without the second property a chip edit followed by a phrase edit could drift.

Two limits are worth knowing because they are shapes the rule type does not
have, not gaps in the parser:

- **An interval rule never writes the word "day."** `every` is a fixed number
  of milliseconds and `calendar` is a wall clock, and "every day" has to mean
  the second one — so one day of interval writes as "every 24 hours". "every 3
  days" is still ACCEPTED; it just canonicalises to hours, which is also the
  honest reading, since an interval really does drift across a DST change.
- **An interval and a time of day cannot both be set.** `calendar` has no
  interval field, so "every 3 days at 9am" is refused rather than silently
  becoming "every day at 9am" and throwing away what was typed.

The editor is the task panel's Schedule section. An unscheduled row shows one
ghost affordance; everything else appears once there is a rule to show.

## What is not here yet

Deliberately, and each is a row of its own:

- **the Scheduled board section** — rule rows have no home of their own on the
  board yet, and Scheduled is separate from Blocked.

The scheduler still never starts a session itself: the wake path asks the
spawner to, and asks a person when nobody answers.
