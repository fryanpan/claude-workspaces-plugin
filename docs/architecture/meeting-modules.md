# Meeting and notes modules, by layer

Where each `meeting-*`, `notes-*` and related module sits in the server's layers. How the meeting assistant behaves is [meeting-assistant.md](meeting-assistant.md).

> Moved out of [overview.md](overview.md) on 2026-11-24, when the overview was cut to a map. "The diagram" and "the picture" below mean the package diagram there.

`core/src/meeting-transcript-fold.ts` and `core/src/speech-lexicon.ts` join
the shared tier and move nothing in the picture, but they are the reason a
`meeting-*` module sits in `core` at all. The fold is a pure function from
the turns a meeting stored to the ROWS a person is shown; the lexicon is the
vocabulary it and `notes-idea-coverage.ts` both ask which words carry no
subject (it moved out of that file, which re-exports every name). They are in
`core` because two packages show a meeting's words as a list of rows and each
used to build that list itself: the server composes
`<docname>-raw-transcript.md` at stop (`formatRawSegment` in
`meeting-raw.ts`), and the board's Transcript fold composes the same grammar
in the browser off the REST record (`loadDocTranscript` in
`speaker-voices.ts`). Two implementations of one grammar are two answers to
"what was said", so both now call the one function. Neither module reads a
file, writes one, or touches the append-only JSONL and the audio beside it —
acknowledgement rides on the row it answered and a wall of words breaks at a
pause, while the record a replay lines PCM up against keeps every turn at its
own number. The meeting's two LIVE surfaces are deliberately untouched: the
strip holds a rolling window of three turns and cannot grow, and the live
zone is one flowing run of inline spans with no per-turn block, so neither is
a list of rows to fold.

`notes-timing.ts` joins the same `notes-*` family in the services tier and
changes none of the picture: it is where one meeting's per-tick latency is
recorded, opened only when the operator turns timing on. It holds no meeting
content — sizes, counts and durations — so it sits beside the notes modules
rather than with the stores that own durable text.

`notes-heading-store.ts` joins it too and changes none of the picture
either: it is the one small file per meeting that records which heading that
meeting's notes are written under, kept beside the meeting's transcript so a
restart mid-recording keeps writing under the section it opened rather than
opening a second one. Ids and a block id, no meeting words, so it sits with
`notes-timing.ts` rather than with the stores that own durable text.

`notes-quality-filed-store.ts` and `notes-quality-meeting-memory.ts` join it
in the same position and change none of the picture either. Between them they
are the quality filer's memory: the memory module holds the map of meetings
it has read, its bound and its eviction rule, and the store is one small file
per meeting recording WHERE that meeting's review item went — the pointer a
later leg revises or withdraws. It is durable for the same reason the heading
record is: a restart ends a recording leg and files the item at once, while
the browser resumes across the gap, so without a file on disk the meeting
ended clean in a new process that had nothing left to take back. Ids, a
verdict's counts and shares, no meeting words; and it is not
`notes-quality-store.ts`, which is the append-only series of READINGS the
daily health check rolls up.

`notes-section-tidy.ts` joins the same `notes-*` family and moves nothing in
the picture: it is the repair on a notes section that neither a prompt nor a
block edit can make — an empty paragraph under the heading, a topic heading
repeating the topic directly above it — and it is the one module here that
writes the document directly rather than through `applyBlockEdits`, because
neither block has an authorship to write through. Two callers, both after a
write has had the last word: the tick path in `meeting-notes-doc.ts` (topic
headings only) and `notes-cleanup-pass.ts` (both). It reads no transcript and
composes nothing.

`notes-group-tags.ts` sits beside it, in the same after-the-write position and
for the same reason: a run of notes that all came from one voice carries its
speaker tag on the bullet ABOVE them rather than on every line, and that is a
fact about the whole group, which is built across several ticks and so cannot
be decided from the one block an edit carries. It moves tags and never notes —
grouping stays by topic, which is `notes-regroup.ts`'s business — and the move
is reversible: a hoisted tag is written with the `g=<count>` marker
(`core/speaker-tags.ts`) that nothing else writes, so a group gaining a second
voice can hand every note its own tag back, and a group that has gained an
untagged note the fold cannot account for is unfolded rather than guessed at. Like the tidy, it writes the
document directly, and like the tidy it reads no transcript and composes
nothing.

`notes-recap-shape.ts` and `notes-recap-apply.ts` join the same family in
the same after-the-write position, once, at a meeting's stop. The first is
pure: it reads the section's markdown and the meeting's spoken sentences and
returns the section with decisions and follow-ups first, each point once and
under the heading of its subject, and no deeper than two levels. The second
writes that into the doc directly, like the tidy, and only when every block
in the section is still the note-taker's and none carries a comment or a
suggestion. Neither composes anything or calls a model.

`notes-cleanup-pass.ts` joins the same `notes-*` family and moves nothing in
the picture either: it is the at-stop tidy-up, and it is deliberately not a
second note-taking path — it reuses `NotesComposer`, the shared
`applyBlockEdits` and the same authorship rules, adding only the whole
transcript, a restraint directive and the gate that decides which of the
returned edits a cleanup is allowed to make. One route calls it
(`routes/meetings-calendar.ts`); nothing else does. `notes-cleanup-scope.ts`
is that gate, split out because it answers a different question: not "run a
pass" but "for a block the model has named, may this pass touch it at all" —
section membership, comment anchors, and whose material it is. Pure, or a
read of the doc; it composes nothing. `notes-cleanup-prompt.ts` is the third
piece and the only one that is not code: the restraint directive and the
transcript label, split off so that rewording the pass's instructions touches
no module that decides anything. It exports two strings, imports nothing and
changes nothing in the picture. `notes-cleanup-gate.ts` is the fourth: it
composes the other gate with `notes-edit-dedupe.ts` — the tick path's "each
note once" check — into the one order that is safe, gating the model's answer
BEFORE the dedupe may rewrite it and again after. It exists because the dedupe
invents edits, so an insert the gate would refuse could otherwise emit an
authorised delete beside it and take the section's only copy of a note with
it. One caller, the pass; nothing else imports it.

`meeting-stream-set.ts` joins that services tier inside the `meeting-*`
family and moves nothing in the picture: it is the fan-out one level below
`meeting-protocol.ts`, opening an engine session per audio stream and folding
two engines' independent turn numbering and speaker labels back into the one
transcript a meeting keeps. The relay still owns the lifecycle; this owns only
what two sessions collide on.

`meeting-silence.ts` joins the same family and changes nothing in the picture
either: it is one window and its resolver, the fifteen minutes of no settled
speech after which `meeting-protocol.ts` ends a recording itself. It sits
beside the relay rather than inside it for the reason `doc-store-timings.ts`
sits outside the doc store — a cadence with an environment override is a
decision a test reads and a reviewer checks, not a number buried in a
`setTimeout`. No state, no `Request`, nothing to schedule: the relay owns the
timer, this owns only how long it runs.

`meeting-takeover.ts` joins the same family and changes nothing in the
picture: one predicate, `samePerson`, and the frame and close code a socket
gets when the person it proved starts or resumes the same meeting on a newer
socket. The relay owns the takeover; this owns only who may make one. The
identity is the one the `/audio` upgrade proved and stamped as `data.author`,
never the start frame's own claim.

`race-deadline.ts` is a leaf under the services tier and changes nothing in
the picture: one function, `raceDeadline(work, ms)`, which settles when the
work settles or when the window runs out, and clears its own timer either way.
It sees no `Request` and holds no state. It exists because
`Promise.race([work, new Promise((r) => setTimeout(r, ms))])` leaves the
deadline's timer scheduled when the work wins, and a referenced timer keeps
the process alive — every shutdown drain in `meeting-protocol.ts` and
`recall-meeting.ts` held one, so a server with no meetings at all sat five
seconds past its own `stop()` before it could exit. Nothing else imports it
yet; a third drain would.

`meeting-namer.ts` and `meeting-titler.ts` join the same family and change
nothing in the picture: a meeting starts as "Meeting" and is renamed to its
topic from its own notes, only while nobody has named it. The namer is the
adapter (prompt, parser, one Haiku call, built only in `server-deps.ts`); the
titler decides when it runs and holds the guard, and `meeting-notes-doc.ts`
calls it from the sinks it already wraps. The one-time rename of the old clock
titles is `retitleClockTitles` in the titler, which `server.ts` starts once
the port is bound, beside the effort re-scoring pass. No route reaches it.

`notes-invented-links.ts` sits in the Meetings box beside `notes-edit-guard.ts`
and is the second deterministic refusal on the applier path: the guard says
which edits may touch the section, this says which links inside them the tick
was actually given, and `applyNotesUpdate` runs both before the store sees a
batch. Pure like the parser — a list of edits and a list of sources in,
rewritten edits and dropped URLs out — so `scripts/notes-eval.ts` counts the
same rule to report how often the composer invents an address.

`notes-scheme-links.ts` is the third, and runs BEFORE the other two on the
applier path. It answers a citation the note-taker wrote as a scheme rather
than as an address — `[the cap](task:Production cost target)`, or the same
words bare in parentheses — which the link check cannot judge because a
markdown destination may not contain a space. Resolved against the titles the
tick was handed it becomes the row's real link; unresolved it comes out as
words, and the `task:` residue goes with it. Pure like its neighbours, and it
adds no box: a list of edits and the tick's own catalogue in, rewritten edits
out.

The `notes-quality-*` family joins the same services tier and adds no new box
to the picture: `notes-quality-report.ts` and `notes-quality-thresholds.ts`
are pure (they read a markdown string and a transcript and answer counts, so
they belong beside `notes-edit-parse.ts` in the domain row on everything but
their filename), `notes-quality-coverage.ts` is the same tier and holds the
one check whose answer depends on something outside the notes — did what was
said reach a note — together with the third state that keeps a FAILED notes
reading from arriving as a confident 100%-uncovered verdict,
`notes-quality-verdict.ts` is pure too and holds one rule — whether two
readings of the same meeting differ enough to re-ask a person about, which is
counts exactly and rates to within a band, so that a share drifting a point
per leg does not re-judge a standing item — `notes-quality-store.ts` and `notes-tick-timing.ts` read and
write under the data dir the way the rest of the `meeting-*` family does, and
`notes-quality-review.ts` and `notes-quality-pass.ts` are the orchestration a
meeting's stop runs — read the notes, judge them, store the reading, file a
bad one on the task the doc belongs to, or on the doc itself when no task
links it. `notes-quality-filing.ts` sits between the pass and that filing and
is the one arrow worth drawing: the stop of a recording LEG is not the end of
a meeting (a dropped socket ends a leg and a resume carries the same meeting
on), so the pass hands its reading there and the filer holds it until the
socket layer says the meeting is over — one item per meeting, revised rather
than duplicated when a later reading changes. `notes-written.ts` joins the pure end of that
family and is the one box worth naming, because it answers WHICH BLOCKS ARE
THE MEETING'S: the note-taker's authorship marks wherever they sit in the
doc, union the section it opened. It reads a doc and answers markdown plus
whether that markdown is a reading at all, writes nothing, and both the
quality pass and the rerun harness address the notes through it — whole-doc
note-taking means a heading id no longer names a meeting's output, and a
reading that finds nothing in a document holding blocks says so rather than
answering the empty string a genuinely empty document would.
`notes-written-blocks.ts` sits beside it in the data-dir tier and keeps the
ids of every block a meeting wrote, across its legs, because each leg
releases the marks `notes-written.ts` reads. `meeting-notes-target.ts` is the
one new arrow on the notes sinks: it decides, once per meeting, whether the
notes go into the doc the meeting was started on or into a notes doc of its
own (when that doc holds a person's writing), and wraps the sinks'
`NotesDocStore` so every read and write lands there. Nothing under `routes/` is added: the
week's rollup rides the existing `GET /api/metrics` reply, for the reason
`uptimeSec` does.

WHAT A TIDY-UP DID, IN THE WORDS A PERSON READS, is
`core/notes-cleanup-report.ts` — a new DOMAIN-tier module in `core`, drawing
no new box: it takes the cleanup route's reply and answers with a headline,
the rules that dropped edits grouped with a count each, a recovery line and
whether another press could answer differently. It sits in `core` because
three surfaces asked the same question about one pass — the offer dialog
(the doc's retired `meeting-cleanup-offer.ts`), `meeting:rerun`'s report file,
and the server's own log line — and a pass that changed nothing has to read
the same way in all of them. The reasons it groups are the gate's own
(`notes-cleanup-scope.ts`), carried out of the route on `refusals` /
`failures`. The two arrays are not written alike — the gate writes a sentence
per dropped edit, the applier writes its error code — so this module reads
each applier code into the gate's own wording as it groups. One fact then gets
one row however it was found, and nothing addressed to a person carries an
identifier. Its recovery line is the commonest rule a reader can act ON,
which is not always the commonest rule.

A BOARD EMBED — a doc line `::sfworks{block="goal-chart"}` showing a board
app's page beneath it — is `core/board-embeds.ts`, a new top-level core module
and no new box: the mapping's shape, the directive parser and the URL builder,
read by both the route that stores the mapping (`routes/workspace-embeds.ts`,
a field on the board record) and the editor decoration that draws the frame
(`workspaces-app/doc/board-embed-frames.ts`). The frame is a view decoration,
never a node, so the doc's text is the line as typed. An
entry names an app door or an allowlisted https origin; the allowlist lives
as `<dataDir>/embed-origins.json`, read per request by the route.

The NOTE-TAKER A DOC USES is five modules and no new box.
`core/notes-method.ts` is the shared vocabulary — the three methods, their
labels and prices, the default, and the parser that drops an unknown one
rather than defaulting it — so the chooser, the wire contract and the server
name the same thing. `notes-method-store.ts` keeps the choice per doc beside
that doc's meetings (`<meetingDir>/notes-method.json`), with who changed it
and when. `notes-method-composer.ts` is one `NotesComposer` that is three: it
reads the doc's method at the top of every compose, so a switch made while
the room is talking is honoured by the next tick and nothing in
`meeting-notes.ts` restarts. `notes-ledger.ts` is the two-pass note-taker's
first pass — a cheap extract that enumerates a tick's points so the compose
is handed a checklist — and every failure in it degrades to the original
rather than to no notes. `notes-section-fit.ts` is the DOMAIN-tier rule for
whether new minutes may write into the section a meeting already owns — which
it finds by the CLAIM the meeting recorded, not by a reserved heading name:
there is no `Meeting notes` container any more, and notes land under the topic
heading they belong to. Two modules joined that tier with it.
`notes-heading-level.ts` derives the level a topic heading is written at from
the document's own outline, so nothing in the notes path hardcodes `##`, and
`notes-heading-rename.ts` decides whether a `replace_block` on a heading is a
rename worth proposing — it comes out as a SUGGESTION whoever owns the block,
via the `propose` flag on `prose.applyBlockEdits`, because renaming the page's
furniture is a reader's call. All three sit beside `notes-edit-guard.ts` in
the row below, which is where the rename is wired in.
`notes-regroup.ts` joins that DOMAIN tier too, and is arithmetic rather than
policy: it reads the outline a tick is about to be composed against, finds the
topics whose flat run has reached the bar `notes-quality.ts` scores, and writes
the block ids into the prompt so the note-taker groups that topic instead of
extending it. It counts runs the way `flatBulletRuns` does, deliberately, so
the directive can never fire on a topic the eval calls fine. It counts a
SECOND thing beside the run — how many notes one heading stands over at all —
because a heading may swallow half an hour without ever holding five bullets
flat, and nesting cannot repair that: the reader meets the same stretch, in
groups. `notes-regroup-ask.ts` is the other half, split off it: the scan
decides what is wrong, the ask decides how to say it to a model, and only the
second is paid for on every tick at full rate. It offers the three remedies
Bryan asked for rather than one — a subtopic bullet with `nest_blocks`, a
subheading or a topic heading placed in front of the note a new part starts at
with `insert_before_block`, and the two composed in a single update, which is
what takes a stretch already on the page apart.
`notes-dictation.ts` and `notes-reason-ask.ts` join the same DOMAIN tier and
add no box. They are two more per-tick directives beside the regroup one. The
first notices a speaker dictating a document ("page one is…", "start with…",
"then…") and names the page heading, the next number and the edit. The
session keeps a small per-meeting memory of the last cue, the way it keeps the
idea ledger, so an ordering word counts only while a dictation is running. On
the tick after a cue it also folds a detail spoken about a page's last item
into that item, so a dash note cannot split the numbered list. The second
quotes any sentence of the tick that gives a reason, so the note for that
point keeps it. `notes-inversions.ts` joins the `notes-quality-*` family: a
pure check, run at the stop, that counts notes saying the opposite of their
source sentence. The count is recorded, not flagged.
`notes-unconfirmed.ts` joins the same DOMAIN tier as the half that settles the
guesses a meeting marked "(unconfirmed)" — it finds them and names their ids to
the cleanup pass, which counts what is left afterwards.

WHAT A MEETING COSTS is three modules and no new box, and the point of them is
that one price table answers both ends. `core/model-cost.ts` is that table —
dollars per million tokens per model family, the cache read and write
multipliers, and the two functions everything else calls (`dollars` for one
call's usage, `perHour` for a total over an elapsed meeting). It sits in core
because the chooser row, the meeting's own report and `scripts/notes-eval.ts`
all quote a price and must not each carry their own arithmetic.
`notes-spend.ts` joins the `notes-*` services family and is pure: a meeting's
recorded calls in, the total and the compose/capture split out, with any model
the table cannot price NAMED rather than counted as free. `notes-cost-store.ts`
sits with `notes-timing.ts` and `notes-heading-store.ts` in that same family —
one small file under the data dir (`meetings/notes-cost.json`) holding, per
note-taker, the last twenty finished meetings as a timestamp, a duration, a
dollar amount and a call count. No meeting content and not even a doc id, so
it belongs with the timing files rather than with the stores that own durable
text. The figure it answers rides the chooser's existing
`GET …/notes-method` read; no route is added.

`notes-edit-guard.ts` joins the DOMAIN tier below as well, and it moves no
boundary either: it is one function over values — a tick's edit list and the
block id of the section this meeting writes under, in; the edits that may be
applied and the reasons for the rest, out. It sits between the composer's
answer and `meeting-notes-doc.ts`'s call to the shared `applyBlockEdits`,
which is the one place a meeting can edit away the heading its own notes hang
from. Pure, so the rule is testable without a doc store; named here because
it is a REFUSAL the picture had no home for — a batch it empties is reported
as `guard-refused` and is deliberately not retried, unlike the write failures
beside it.

`notes-edit-bullets.ts` runs just before the guard, in the same tier: a
tick's edits and the outline in, the same edits out with every top-level prose
line made a bullet. It is the answer to "what if the model writes a note as a
paragraph", and no boundary moves. `notes-pending-clauses.ts` runs on its
output, same tier: a note's trailing "not finished yet" report comes off, and
a note that is only that report is dropped.

`notes-edit-dedupe.ts` sits right after it in the same flow and the same
tier: the guard's edits and the doc's outline in, the same edits out with a
topic heading the section already has re-addressed to it, a note it already
carries dropped or moved, and a `Decision:` label nobody spoke taken off. Pure
like the guard, and named for the same reason — it is the answer to "what if
the model writes it twice anyway", which no box above says.

`notes-edit-correction.ts` is the guard's own question split out, in the same
tier and the same place in the flow: whether a note the tick writes is the
speaker taking back one already there, judged on the tick's speech. The guard
asks it of a replace, and of an insert, which it turns into a replace of the
one note the insert withdraws. Pure, and no boundary moves.

`notes-idea-coverage.ts` joins the DOMAIN tier below, not this one, and it
changes no boundary: it is functions over values — sentences in, a verdict on
whether the notes carry them out — plus a per-meeting ledger the notes session
owns. It is named here only because it is the answer to a question the picture
did not previously have anywhere to ask: whether a tick's speech produced a
note, as opposed to whether it reached the composer.

`notes-missed-words.ts` joins the DOMAIN tier beside it and moves no boundary
either: a retried line and the notes so far in, the words of the line no note
carries out. The prompt builder calls it so the retry block names what is
absent rather than asking the note-taker to judge what is carried — the
judgement that let the reason of an "X because Y" line go while its point
stood.

`notes-recent-speech.ts` joins the same DOMAIN tier and moves no boundary:
the previous tick's speech and this tick's in, the tail of the earlier one out,
which the prompt builder shows as context the note-taker must not note again.
It exists because the cadence ceiling cuts a long answer into slices, and a
slice read alone has lost its subject.

`notes-coverage-judge.ts` is a services-tier adapter beside the meeting namer:
once a meeting is over, the quality filer's `amend` hands it the transcript and
the notes, and one Haiku call per stretch of speech says which points no note
carries. Its share replaces the lexical coverage reading on the item, so a
meeting that lost ideas is reported. No boundary moves: it is one more model
call behind the same key and consent as the composer.

`meeting-home.ts` is the one new top-level module in the Meetings box, and it
holds the two facts a meeting needs before anybody speaks: which folder of its
project it files into, and how much of it that project chose to keep. The
choice sits on the `ProjectRecord` the mount registry already keeps per
project, beside privacy and the conventions path, because it is the same kind
of thing — something the project decided and this server applies. The filing
record beside it is one append-only line per meeting saying which board,
project and lead seat the conversation belonged to, folded on read like
`meetings.jsonl` next door. Retention is expressed as what is never WRITTEN,
so nothing here deletes; `meetings.ts` asks it once at start and carries the
answer on the meeting. `routes/mounts.ts` is the lead's door to the choice and
`routes/doc-title.ts` is the fourth member of the docs chain, which is where a
person renames the meeting the clock named. On the client `doc/doc-rename.ts`
joins the existing `doc/` family in the view tier and adds no box: it makes
the topbar title its own editor.
