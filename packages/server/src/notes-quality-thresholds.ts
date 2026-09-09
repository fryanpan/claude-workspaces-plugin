/**
 * The numbers that decide whether a meeting's notes came out badly.
 *
 * ONE MODULE FOR ALL OF THEM, because every one of these is a judgement about
 * what a reader will tolerate rather than a fact about the code, and a
 * judgement spread across five call sites is a judgement nobody can revise.
 * Each constant below says where its number came from; a number with no
 * provenance is a number the next person has to re-derive from scratch.
 *
 * HOW THE NUMBERS WERE PICKED. Every meeting this server has recorded was
 * scored with the checker in `notes-quality-report.ts` before these were
 * chosen, and the shape of that corpus is the argument: healthy meetings sit
 * at or very near zero on every count, so a bar just above the healthy
 * maximum separates "a meeting went wrong" from "notes are notes".
 *
 * THE MEETING THAT MOTIVATED THE WORK IS NOT IN THAT CORPUS, and the bars are
 * not derived from it. It was described as a doc carrying 33 duplicate lines,
 * a lost topic and invented speakers; the worst duplicate count any RECORDED
 * meeting scores is one, and the doc in the corpus that does carry a hundred
 * or so repeated lines has no meeting record beside it at all, so nothing
 * here can be checked against it. What the bars are derived from is the
 * distribution of the meetings that were recorded — which is a weaker claim
 * than "these bars would have caught that meeting", and is stated as one.
 *
 * COUNTING IS ALWAYS ON; THESE ARE ONLY THE REPORTING BARS. The report counts
 * every defect it can see whatever these say. What a threshold decides is the
 * narrower question of whether the meeting is worth interrupting a person
 * about — see `notesQualityFlags`. Keeping the two apart is what lets the
 * daily rollup show a trend that no single meeting was ever reported for.
 */

/**
 * Repeated bullets — the same line written twice — a meeting may carry before
 * it is reported.
 *
 * Three. Across the whole recorded corpus the worst meeting carried ONE
 * repeated bullet and every other carried none, so three sits clear of the
 * noise; the failure the ticket describes was dozens, which is far above it.
 * A repeat is counted as an extra LINE,
 * not as a group: a bullet written four times is three repeats, because three
 * is what a reader has to skip past.
 */
export const MAX_DUPLICATE_BULLET_LINES = 3;

/**
 * Headings repeated — the same topic opened twice — before it is reported.
 *
 * One, not zero. Two meetings in the corpus opened one topic twice and read
 * fine: a heading written again after a long gap is a real thing a note-taker
 * does when the room comes back to a subject. Two repeats in one meeting is
 * the section losing track of itself, which is the failure.
 */
export const MAX_DUPLICATE_HEADINGS = 1;

/**
 * Topics that run as a flat wall of bullets, before it is reported.
 *
 * One. How LONG a run may be is already decided —
 * `MAX_FLAT_RUN_BULLETS` in `notes-quality.ts`, four, the number the prompt
 * states — so this is only how many such runs a meeting may have. One
 * appears in healthy meetings of every length in the corpus, usually the
 * meeting's own last topic, which never got the regrouping pass a later topic
 * would have triggered. Two or more is the note-taker not regrouping at all.
 */
export const MAX_LONG_FLAT_RUNS = 1;

/**
 * Speakers the meeting never had, before it is reported.
 *
 * ZERO, and it is the only zero here. Every other count on this page is a
 * matter of degree; a name attached to a voice that never spoke is a
 * fabrication, and one is as bad as ten because a reader who finds one
 * stops believing the other attributions. Six meetings in the corpus do it,
 * one or two invented names each, and the worst is a nineteen-turn
 * conversation whose notes name two voices the transcript never had.
 */
export const MAX_UNKNOWN_SPEAKERS = 0;

/**
 * The share of spoken ideas the notes may leave unaccounted for.
 *
 * Half, and the number is a GAP in the measured distribution rather than a
 * round figure. Scored over every meeting this server has recorded, the
 * meetings whose notes a reader would call complete run from 3% to 36%
 * uncovered; the ones that were visibly thin — including one that recorded a
 * full hour of speech and wrote no notes at all, which scores 100% — run from
 * 55% up. Nothing sits between. Half is the middle of that empty band, so the
 * bar is not balanced on any single meeting's number.
 *
 * The check behind it is lexical and its errors run one way — it calls a
 * paraphrase a miss more often than it calls a miss covered (see the module
 * header of `notes-quality-report.ts`) — so the bar HAS to sit well above the
 * miss rate a healthy meeting scores rather than near the rate a perfect one
 * would.
 */
export const MAX_UNCOVERED_IDEA_SHARE = 0.5;

/**
 * The fewest ideas a meeting must have before its coverage share is judged.
 *
 * Ten. A one-minute meeting can hold three ideas, and two of them missed is
 * a two-thirds miss rate that says nothing — the denominator is too small for
 * the ratio to mean anything. Ten is roughly a two-minute conversation, the
 * point below which the corpus's coverage numbers stop being stable between
 * neighbouring meetings.
 */
export const MIN_IDEAS_FOR_COVERAGE = 10;

/**
 * How long after a turn settles its note may land before the wait is late.
 *
 * A minute. The notes clocks are held at four seconds of quiet and a
 * fifteen-second cadence ceiling (Bryan, 2026-09-04, and
 * `DEFAULT_NOTES_QUIET_MS` / `DEFAULT_NOTES_CADENCE_MS` are where they live),
 * so a healthy turn reaches a note inside one cadence window plus the compose
 * itself. Sixty seconds is four of those windows: long enough that ordinary
 * jitter and one slow compose never trip it, short enough that the notes
 * falling a topic behind the room does.
 *
 * WHAT THE NUMBER IS MEASURED FROM, which the four-windows reasoning above
 * understates. `settledToWrittenMs` is charged from the OLDEST turn on a
 * tick, so a tick carrying three turns is timed from the first of them. It is
 * therefore "how long the oldest idea went unwritten", not "how long one turn
 * waited", and it runs higher than a per-turn figure — measured at 21s median
 * against the same replay's 7.5s per-turn median. That is the right number
 * for this bar (a reader is waiting on the oldest thing still missing), but
 * anyone comparing it to a per-turn latency elsewhere is comparing two
 * denominators.
 */
export const LATE_NOTE_MS = 60_000;

/**
 * The share of a meeting's turns that may land late before it is reported.
 *
 * One in five. A single late note is one slow call to a model; a fifth of the
 * meeting arriving a minute behind is the notes not keeping up, which is the
 * shape `refusedTooLong` already reports from the other side.
 *
 * THE ONE REAL MEASUREMENT SO FAR SITS UNDER IT, and that is worth knowing
 * before trusting this bar. A replay of a real 169-turn meeting scores nine
 * late ticks in seventy-one — 13%, under this bar — with a median of 21s and
 * a worst of 254s (`test/fixtures/notes-timing-replay.jsonl`, asserted in
 * `notes-tick-timing-real.test.ts`). So this bar catches a meeting that is
 * late THROUGHOUT and not one that is late in a long tail. Whether a tail
 * like that deserves its own bar — a median over some ceiling, say — is a
 * judgement nobody has enough meetings to make yet, and one file is not a
 * distribution. Deliberately left alone rather than tuned to it.
 */
export const MAX_LATE_NOTE_SHARE = 0.2;

/**
 * How far back the rollup the daily health check reads looks.
 *
 * Seven days, matching `UPTIME_WINDOW_MS` — the other number on the same
 * reply, read by the same check, and a reader comparing two windows of
 * different lengths on one screen is a reader being misled for no reason.
 * Seven is also long enough that a week with two meetings in it still says
 * something, which a 24-hour window on this corpus would not.
 */
export const NOTES_QUALITY_WINDOW_MS = 7 * 24 * 60 * 60_000;
