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
