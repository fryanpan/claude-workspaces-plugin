# Unfiled asks — the detector, and what it is measured to get wrong

The rule is that any ask to the board's owner exists as an answerable review
item before the turn ends, and chat carries a pointer only. It has been
written down for weeks and is still broken several times a week. This is the
measurement of how often, and the nudge that fires while the turn that made
the ask is still open.

Two files hold it. `unfiled-ask.ts` decides whether a closing message ASKS —
pure text, no board, no clock. `unfiled-ask-filing.ts` decides whether the
agent has FILED — one walk of the open tasks, which also answers who the
people on this board are. `routes/dispatch-and-notes.ts` joins them on the
Stop hook's note route.

## Why the closing message is the whole corpus

The Stop hook already posts every end-of-turn message to the task's Activity
tab. So the server sees one line of chat per turn, has done since agent notes
shipped, and the detection needs nothing new — a turn that asks a question and
files nothing is visible at the moment it happens. (`chat-audit.ts` used to
say the server never sees chat. That was false when it was written.)

What it does NOT see is everything else in the turn: an ask made in the middle
of a long turn and not repeated at the end is invisible here, and so is an ask
made in a tool call. The number below is a floor.

## The words half

An ask is a sentence that is addressed to the reader AND either ends in a
question mark or matches one of ~20 deferral phrase families (`your call`,
`say the word`, `want me to`, `waiting on`, `needs your <noun>`, …).

"Addressed to the reader" is a second-person pronoun, a first-person offer
(`want me to`, `shall we`), or one of the owner names. **The names are data,
not a constant**: they come from whoever has moved a task on this board as a
person, capped at eight, so this file names nobody and a second deployment
gets its own owner for free.

Before any of that, the message is reduced to prose: fenced blocks, code
spans, quoted strings, link targets and bare URLs are removed, because `$?` is
not a question and a quoted question is somebody else's. A sentence is
suppressed when it negates (`not asking`, `nothing from you`) or reports
(`I already asked`, `I told them`).

## The filing half

An agent is filed when it has an open review item of its own on the board's
open tasks, or filed one since its previous turn note. Two conditions rather
than one: a session pointing at an item it filed earlier is complying, and a
session that filed one this turn has just closed the gap. Only a session with
neither has put an ask somewhere nobody reads.

## What was measured, and how

Corpus: **913 end-of-turn notes** on disk in prod, from a read-only copy of
the data directory. Five agents; the largest contributed 470. Only 45 of the
913 (4.9%) contain a question mark at all, which is the first reason a
question-mark rule alone would be useless.

Labelling was by hand, two labels per message: `ask` (puts a question,
decision or wait to the owner — pointers to already-filed items included) and
`unfiled` (the ask is not already an answerable item). The second is the one
that matters.

Tuning and evaluation were kept apart. **109 messages were read while
iterating** and are excluded from every number below. The evaluation set is
the **631 messages the tuning never read**, stratified by the pre-fix
detector's own verdict and sampled blind within each stratum:

| Stratum | Size | Labelled |
| --- | --- | --- |
| Detector said ask | 48 | 40 |
| Detector said nothing | 586 | 70 |
| **Distinct messages** | **631** | **110** |

The two strata overlap by 3 messages (48 + 586 = 634 against a union of 631),
so the weighting double-counts three of them. That is a 0.5% error, named here
rather than hidden, and far inside the sampling error of a 110-message
hand-label. The figures below are estimates, and the second digit of each is
not real.

Each stratum's counts are weighted back to its size.

## The result

Raw, before weighting: on the positive stratum 29 true positives, 7 false
positives, 4 missed asks; on the negative stratum 2 true positives, 0 false
positives, 11 missed asks. Weighted to the population:

| Figure | Value |
| --- | --- |
| Messages in the evaluation set | 631 |
| Hand-labelled | 110 |
| Estimated asks of any kind | ~148 |
| Estimated UNFILED asks | ~39 |
| Detector positives | ~60 |
| **Precision** | **86%** |
| Recall, asks of any kind | 35% |
| **Recall, unfiled asks** | **15%** |

So: about one in seven of the asks that reach the owner as chat is caught, and
about one in seven of what the detector flags is not an ask at all.

## What the misses look like, and why recall was chosen over precision

The catches are explicit: an offer, a stock deferral, a direct question. The
misses are almost entirely IMPLICIT — no question mark and no stock phrase: a
list of things the owner now has to do, or a sentence saying several goals
depend on the owner this afternoon. A phrase match cannot see those, and no
amount of tuning made it.

One tuning pass raised precision to 96% by requiring a wait word near the
`your <noun>` family. It also cut unfiled-ask recall from 15% to 3%, and was
removed. A false positive costs one turn; a miss costs the whole point.

## The 2026-09-15 re-measurement

Re-run when the stall clock began reading the same detector, because a reader
two features now depend on is worth a fresh number rather than an inherited
one.

**Corpus.** Every end-of-turn note posted on any board of this server between
14 and 16 September 2026: **157 notes** across five boards with owners on
them, read through the REST task surfaces only (`GET /workspaces`, then the
per-board task list and each candidate task's `/detail`). The prod data
directory was never read; a per-task notes GET does not exist, and the
per-agent ring held only 16 rows, so `/detail` is what the numbers rest on.
Candidates were every task whose `updatedAt` was on or after 14 September,
which is every task that could carry a note in the window, since appending one
stamps it.

**Label.** One label this time, by hand over all 157: does the note put a
question, a decision or a wait on a PERSON — including "waiting on <owner>",
"in your queue", "yours to rate". 36 of the 157 were asks by that reading.

The filed/unfiled split of the 2026-09-10 run could NOT be reproduced
honestly. Reconstructing, per note, whether an answerable item stood on the
owner's queue at that moment needs review-item history the readable surfaces
do not carry, and guessing it would have produced a number that looked like
the old one and meant something else. So the figures below are recall on ASKS,
against the older run's 35% on the same quantity; the 15% unfiled-ask recall
is not restated because it was not re-measured.

| Figure | Before | After |
| --- | --- | --- |
| Notes | 157 | 157 |
| Hand-labelled asks | 36 | 36 |
| Detector positives | 11 | 16 |
| True positives | 11 | 15 |
| **Recall, asks** | **31%** | **42%** |
| **Precision** | **100%** | **94%** |

**What the tuning was.** Three narrow changes, each aimed at a miss the
corpus made common, none of them a new family of phrase:

- A lead writes the name they SAY. The board learns owners from transitions,
  where a person appears under a full name; every wait in the corpus used the
  first name alone. `ownerPattern` now also accepts the leading token of a
  multi-word owner name, and only when it is three characters or more — a
  two-letter token would match inside ordinary prose.
- `on your queue` became `on|in your queue`.
- `yours to do` gained `take`, `rate`, `open`, `pick` and `choose`.

The widened queue phrase created one false positive — a note whose first words
were "Not an ask", naming the items it had already filed — so `not an ask`
joined the suppressors, which is a negation of exactly the kind already there.

**Precision was not bought at recall's expense**, and the single remaining
false positive says why the trade is the right way round: it is a note
reporting that a wait on the owner had been ANSWERED and executed. Telling a
lead about a task that is fine costs one line in a frame they were already
getting. Missing one costs the task.

## Two things this deliberately does not do

**It does not file anything.** The nudge is a `decision: "block"` back to the
agent that made the ask, and nothing else. Nothing new appears on the owner's
queue — a hook that filed a review item for every question mark would be its
own noise, and would be worth building only once the false-positive rate above
is known to be lower than it is.

**It does not nudge twice.** The Stop hook's payload carries
`stop_hook_active` on the turn a block reopened; the continuation still posts
its note to the Activity tab (that message is the one a reader most wants) and
is never nudged again.

## Where the note itself goes, and what a many-row board loses

The judgement runs on every turn note the route accepts, before the note is
matched to a row — so an agent holding twenty-five in-progress rows is judged
exactly like one holding a single row, and the counter moves either way. What
a many-row board loses is the NOTE. `resolveNoteTarget` answers with a row
only when the agent holds exactly one in-progress claim on the board, because
a judged sample put the old newest-claim guess wrong about three times in
four; a note it will not place lands on no task, emits no `task.noted`, and
appears nowhere in `events.jsonl`.

That was measured on this fleet over 14-17 September 2026: 335 turn notes, all
from boards where one agent held one or two rows. One board logged 494 turn
notes up to 2026-09-02 and none in the fifteen days after, while 1,793 status
notes kept arriving — `post_status` names its row and takes the explicit
address, which the Stop hook has no way to do.

The note now also goes to `agent-note-log.ts`, which appends it to
`<dataDir>/workspaces/<ws>.agent-notes.jsonl`. It is still not placed on a row:
the no-guess rule is unchanged, and the log is a record that the note existed
rather than a decision about where it belongs. So a count of a board's turn
notes is the sum of two files, and neither alone:

```bash
grep -c '"event":"task.noted"' <data>/workspaces/<ws>.events.jsonl   # placed
grep -c '"kind":"turn"'        <data>/workspaces/<ws>.agent-notes.jsonl  # unplaced
```

`GET /workspaces/<ws>/agents/<name>/notes` merges the two, so the agent's own
recent-activity read is one call and survives a restart. `lastTurnAt` — the
boundary "filed nothing this turn" is measured from — falls back to the log
when the in-process ring has nothing, which is what a restarted server used to
have.

### What every corpus on this page could not see

Both measurements above were read from placed notes — the 913-note run and the
157-note re-measurement through the boards' own task surfaces, which is where a
note lands only once a row takes it. **Neither number is wrong. Each is a
corpus of placed notes, which was all there were**: an unplaced note reached
the ring and nothing else, so no read could have recovered it. The rates still
describe the messages they were computed over. What they do not describe is the
population, and the gap between the two has a direction — the boards excluded
are the busy ones, where a session holds many rows.

The second gap is upstream of the server entirely. A Stop hook that cannot
resolve a board id posts nothing, so its turns are in no corpus and no log,
and the board looks quiet rather than broken. Two boards on this fleet were
in that state with neither `CW_WORKSPACE_ID` nor `FEEDBACK_WORKSPACE_ID` set
in their session environment; a third had both set to a real board, ended
turns, and still produced no turn row ever, which the server-side cause above
does not explain and which is still open.

Whoever re-measures next: the denominator is the sum of the two files, and a
board contributing zero is a question about its hook before it is a fact about
its agents.

## The count is about the person, not the board

A live row records the board it was seen on. The window does not filter by it,
on purpose: the question is how many asks reached the OWNER as chat, and the
owner is one person across every board he keeps. A per-board window would also
read zero for every row the daily audit has ever published, because a
transcript miner knows no board. The field is recorded so that a later surface
which genuinely is about one board can filter without a migration.

## Re-measuring

The two rates are constants in `routes/workspace-attachments.ts`
(`ASK_ACCURACY`) and on the board notice beside the count, because nothing in
the running server measures them: a person labelled a sample. Whoever labels
the next one changes those numbers, and this file, in the same commit.
