/**
 * WHETHER A RECORDING MAY CARRY ON UNDER THE HEADING A MEETING ALREADY WROTE,
 * or has to start a topic of its own.
 *
 * THERE IS NO RESERVED SECTION ANY MORE (owner, 2026-09-15: notes land under
 * the topic they belong to, and a doc with nowhere to put them gets a topic
 * heading, not a container). So the question this file used to ask — "is the
 * doc's `Meeting notes` heading free" — cannot be asked: there is no such
 * heading and nothing matches on its words. What is left is the question that
 * was always the real one, and it is answered from the RECORD rather than
 * from any text:
 *
 *   A heading SOME MEETING HAS CLAIMED is a meeting's; anything else is the
 *   document's own and this recording never writes into it.
 *
 * `claims` is that record: every heading a meeting has taken on this doc, by
 * block id — the in-process memory's own adoptions plus whatever the heading
 * store holds from earlier meetings and earlier processes — each carrying the
 * moment its meeting stopped, where one was recorded. It outlives the
 * meeting, the authorship and the process, which is exactly what authorship
 * does not: `releaseNotesAuthorship` drops the note-taker's claim on every
 * block when a recording STARTS, so by the time this question is asked a
 * previous meeting's minutes are authorless and look like a person's notes.
 * Judging on authorship merged two conversations under one heading;
 * `notes-heading-restart.test.ts` and `notes-second-meeting.test.ts` both
 * caught it.
 *
 * AND THE SECOND HALF IS WHETHER THAT MEETING IS OVER (2026-09-11). A claim
 * alone refused every second recording on a doc, which is what Bryan saw: he
 * stopped a recording, started another minutes later, and the notes opened a
 * second heading at the bottom of the page while the one from minutes earlier
 * sat above it. One conversation, two headings.
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
import { notesTopicLevel } from './notes-heading-level.ts';
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
 * Where the section both readers would use starts, or `-1` for a doc no
 * meeting has written a heading into.
 *
 * THE LAST CLAIMED ONE. A doc may carry several meetings' headings by now;
 * the one a new recording could continue is the newest, because writing into
 * an earlier one would put today's words above a previous meeting's.
 */
export function lastClaimedHeadingIndex(
  outline: readonly prose.OutlineEntry[],
  claims: ReadonlyMap<string, NotesSectionClaim>,
): number {
  let at = -1;
  outline.forEach((e, i) => {
    if (e.kind === 'heading' && claims.has(e.id)) at = i;
  });
  return at;
}

/**
 * Where a meeting's section STOPS: the first heading at that heading's own
 * level or above, or the end of the doc.
 *
 * THE LEVEL IS THE WHOLE RULE, and neither "the next heading" nor "the end of
 * the doc" is right on its own. A topic heading the meeting wrote under its
 * own is deeper, so stopping at the next heading of any level would read a
 * full set of minutes as an empty section and reuse it. Running to the end of
 * the doc instead reads whatever section comes AFTER the notes as though it
 * were part of them, so one authored paragraph in an unrelated section three
 * headings later refuses a section that is genuinely free.
 *
 * THE LEVEL IS NEVER ASSUMED. An entry with no level of its own is read at
 * the level THIS DOC writes its sections at (`notes-heading-level.ts`), not
 * at two — a doc whose sections are `###` had every one of its headings read
 * as deeper than a section and swallowed.
 */
export function notesSectionEnd(outline: readonly prose.OutlineEntry[], at: number): number {
  const level = outline[at]?.level ?? notesTopicLevel(outline);
  for (let i = at + 1; i < outline.length; i++) {
    const entry = outline[i];
    if (entry?.kind === 'heading' && (entry.level ?? 0) <= level) return i;
  }
  return outline.length;
}

/**
 * Whether the last claimed section is one new minutes may carry on under.
 *
 * `now` is only ever compared against a recorded stop, so a test says how
 * long ago a meeting ended by writing the record, not by moving a clock.
 *
 * `true` on a doc with NO claimed heading as well: there is nothing to be
 * stranded by and nothing to write into by mistake, so the meeting starts a
 * topic of its own exactly as a meeting on a fresh doc does.
 */
export function notesSectionFits(
  outline: readonly prose.OutlineEntry[],
  claims: ReadonlyMap<string, NotesSectionClaim> = new Map(),
  now: number = Date.now(),
): boolean {
  const at = lastClaimedHeadingIndex(outline, claims);
  if (at < 0) return true;
  // Where this section ends. Everything past it belongs to some other part of
  // the doc and says nothing about whether these minutes may be written here.
  const end = notesSectionEnd(outline, at);
  // NOTHING UNDER IT FITS EVERY TOPIC, AND THIS IS ASKED FIRST — before the
  // claim, deliberately. A meeting that opened a heading and then wrote
  // nothing beneath it (it was cut short, every tick was refused, the room
  // said nothing worth a bullet) leaves a claimed but empty heading. Asked
  // the other way round, the claim rejected it and the next meeting opened a
  // SECOND heading directly under an identical empty one — which is precisely
  // the duplicate-heading shape this whole rule exists to prevent, arrived at
  // from the other side.
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
  // disk can say — including one the process died under, where starting a
  // topic of its own is the older behaviour and the safe one.
  // A claimed heading with no claim behind it means the doc changed under the
  // caller between the two reads. Treat it as the document's own — the answer
  // that writes nowhere rather than the one that writes into somebody's page.
  if (claim === undefined) return false;
  return claim.endedAt !== undefined && now - claim.endedAt <= NOTES_CONTINUATION_WINDOW_MS;
}
