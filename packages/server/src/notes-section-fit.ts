/**
 * WHETHER NEW MINUTES MAY WRITE INTO THE `Meeting notes` SECTION THAT IS
 * ALREADY THERE, or have to open their own.
 *
 * The owner's rule (2026-09-09): new minutes REUSE an existing Meeting notes
 * section when its topic fits, and open their own when it does not. This is
 * the "fits" half, as one function over values.
 *
 * WHAT "FITS" MEANS, OPERATIONALLY. A doc can carry a `Meeting notes` heading
 * for two quite different reasons, and only one of them is somebody else's:
 *
 * - A PREVIOUS MEETING'S MINUTES. Writing today's meeting under yesterday's
 *   heading is what the owner's 2026-08-31 rule forbids, so these minutes
 *   open their own section below it and the earlier one keeps every line.
 * - THE DOC'S OWN STANDING SECTION — a heading somebody typed, holding their
 *   own notes or nothing at all. That is not another meeting's record, it is
 *   this doc saying where its minutes go. Opening a SECOND heading beside it
 *   is what strands the person's lines: both readers of a notes section take
 *   the LAST heading with that text (`notesSectionStart` in the client, the
 *   server's own finder), so everything above the new heading leaves the
 *   notes while staying in the doc.
 *
 * MEASURED, not supposed. The eval seeds exactly the second shape — a
 * `Meeting notes` heading with one human bullet under it — and every tick of
 * every meeting reported the person's bullet gone from the notes: the doc
 * held two headings, the reader took the second, and the bullet sat above it.
 * `bun run notes:eval` scored "a person's bullet is never edited" at 0% while
 * nothing had edited it.
 *
 * AUTHORSHIP IS NOT THE TEST, AND THE FIRST VERSION OF THIS FILE GOT THAT
 * WRONG. `releaseNotesAuthorship` drops the note-taker's claim on every block
 * when a recording STARTS — deliberately, so the new meeting cannot rewrite
 * the old one's bullets — so by the time this question is asked a previous
 * meeting's minutes are authorless and look exactly like a person's own
 * notes. Judging on authorship adopted the previous meeting's section and
 * merged two conversations under one heading; `notes-heading-restart.test.ts`
 * and `notes-second-meeting.test.ts` both caught it.
 *
 * WHAT IS DURABLE IS THE HEADING RECORD. Every meeting that opens or adopts a
 * section writes that block id down beside its own transcript
 * (`notes-heading-store.ts`), and that record outlives the meeting, the
 * authorship and the process. So the first half of the test is: a heading
 * SOME MEETING HAS CLAIMED is a meeting's section, and anything else is the
 * doc's own.
 *
 * AND THE SECOND HALF IS WHETHER THAT MEETING IS OVER (2026-09-11). A claim
 * alone refused every second recording on a doc, which is what Bryan saw:
 * he stopped a recording, started another one minutes later, and the notes
 * opened a second `## Meeting notes` at the bottom of the page while the
 * section from minutes earlier sat above it. One conversation, two headings,
 * and the reader's own `notesSectionStart` takes only the last of them.
 *
 * A claim therefore says whose the section is while the meeting is RUNNING —
 * two recordings live on one doc still keep their sections apart, which is
 * the case the claim was built for — and stops saying it once the meeting has
 * stopped. A recording started soon after is the same conversation carrying
 * on, so its notes continue under the heading that is already there.
 *
 * SOON AFTER, AND NOT FOREVER, is what keeps the owner's 2026-08-31 rule
 * alive for the shape it was written for: a standing doc that hosts a meeting
 * every week is not one conversation, and yesterday's minutes are not
 * something to write today's under. `NOTES_CONTINUATION_WINDOW_MS` is the
 * line between the two, read against the moment the claiming meeting stopped
 * rather than against any clock a test has to fake.
 */

import type { prose } from '@claude-workspaces/core';
import { MEETING_NOTES_HEADING } from './notes-doc-access.ts';
import type { NotesSectionClaim } from './notes-heading-store.ts';

/**
 * How long after a meeting stops its section is still the one a new recording
 * writes into.
 *
 * FOUR HOURS: long enough that everything a person means by "I started it
 * again" lands inside it — a stop for a break, a laptop that slept, a crash,
 * a deploy, a meeting that resumed after lunch — and short enough that the
 * next day's meeting on the same doc opens a section of its own. It is read
 * against the claiming meeting's own stop, so nothing here depends on how
 * long this process has been up.
 */
export const NOTES_CONTINUATION_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * Where the section both readers would use starts, or `-1` for a doc with no
 * `Meeting notes` heading at all.
 *
 * THE LAST ONE, because that is the one the client's `notesSectionStart` and
 * the server's finder both take. A "fits" answer about any other heading
 * would be an answer about a section nobody reads.
 */
export function lastNotesHeadingIndex(outline: readonly prose.OutlineEntry[]): number {
  let at = -1;
  outline.forEach((e, i) => {
    if (e.kind === 'heading' && e.text.trim() === MEETING_NOTES_HEADING) at = i;
  });
  return at;
}

/**
 * Where the notes section STOPS: the first heading at the notes heading's own
 * level or above, or the end of the doc.
 *
 * THE LEVEL IS THE WHOLE RULE, and neither "the next heading" nor "the end of
 * the doc" is right on its own. Every topic heading a meeting writes lives
 * INSIDE the section — the instructions ask for `###` under the `## Meeting
 * notes` — so stopping at the next heading of any level would read a full set
 * of minutes as an empty section and reuse it. Running to the end of the doc
 * instead reads whatever section comes AFTER the notes as though it were part
 * of them, so one authored paragraph in an unrelated section three headings
 * later refuses a notes section that is genuinely free.
 */
export function notesSectionEnd(outline: readonly prose.OutlineEntry[], at: number): number {
  const level = outline[at]?.level ?? 2;
  for (let i = at + 1; i < outline.length; i++) {
    const entry = outline[i];
    if (entry?.kind === 'heading' && (entry.level ?? 0) <= level) return i;
  }
  return outline.length;
}

/** Whether anything at all sits under the doc's last notes heading. An empty
 *  section fits every topic, which is the case that shipped first. */
export function notesSectionIsEmpty(outline: readonly prose.OutlineEntry[]): boolean {
  const at = lastNotesHeadingIndex(outline);
  if (at < 0) return false;
  return notesSectionEnd(outline, at) === at + 1;
}

/**
 * Whether the doc's existing notes section is one new minutes may write into.
 *
 * `claims` is every section a meeting has recorded on this doc, by heading
 * block id — the in-process memory's own adoptions plus whatever the heading
 * store holds from earlier meetings and earlier processes — each carrying the
 * moment its meeting stopped, where one was recorded. A caller with no such
 * record passes an empty map, which is the honest state for a note-taker
 * built without a store: it can only see the doc.
 *
 * `now` is only ever compared against a recorded stop, so a test says how
 * long ago a meeting ended by writing the record, not by moving a clock.
 *
 * `true` on a doc with NO notes heading as well: there is nothing to be
 * stranded by and nothing to write into by mistake, so the composer opens the
 * section itself exactly as it always has.
 */
export function notesSectionFits(
  outline: readonly prose.OutlineEntry[],
  claims: ReadonlyMap<string, NotesSectionClaim> = new Map(),
  now: number = Date.now(),
): boolean {
  const at = lastNotesHeadingIndex(outline);
  if (at < 0) return true;
  // Where this section ends. Everything past it belongs to some other part of
  // the doc and says nothing about whether these minutes may be written here.
  const end = notesSectionEnd(outline, at);
  // NOTHING UNDER IT FITS EVERY TOPIC, AND THIS IS ASKED FIRST — before the
  // claim, deliberately. A meeting that opened a section and then wrote
  // nothing beneath it (it was cut short, every tick was refused, the room
  // said nothing worth a bullet) leaves a claimed but empty heading. Asked
  // the other way round, the claim rejected it and the next meeting opened a
  // SECOND `Meeting notes` heading directly under an identical empty one —
  // which is precisely the duplicate-heading shape this whole rule exists to
  // prevent, arrived at from the other side.
  //
  // Nothing is lost by adopting it: an empty section holds no minutes to
  // merge two conversations into, so the 2026-08-31 rule has nothing to
  // protect here.
  if (end === at + 1) return true;
  const id = outline[at]?.id;
  const claim = id === undefined ? undefined : claims.get(id);
  // A heading a meeting has already claimed AND WRITTEN UNDER is that
  // meeting's record, whatever the blocks are currently attributed to — for
  // as long as the meeting is running. This is the clause that survives
  // `releaseNotesAuthorship`.
  //
  // Once it has stopped, the section is the doc's minutes, and a recording
  // started inside the window is the same conversation continuing into them.
  // A meeting with no stop recorded is still running as far as anything on
  // disk can say — including one the process died under, where opening a
  // section of its own is the older behaviour and the safe one.
  if (claim !== undefined) {
    return claim.endedAt !== undefined && now - claim.endedAt <= NOTES_CONTINUATION_WINDOW_MS;
  }
  for (let i = at + 1; i < end; i++) {
    const entry = outline[i];
    if (!entry) continue;
    // Authorship is a WEAKER signal than the record and is kept only for the
    // window where it is still true: a meeting writing right now, on a
    // note-taker with no heading store. It never fires for a meeting that has
    // stopped, because starting the next one releases every claim.
    if (entry.author !== undefined) return false;
  }
  return true;
}
