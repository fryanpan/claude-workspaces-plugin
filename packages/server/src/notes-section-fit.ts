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
 * authorship and the process. So the test is: a heading SOME MEETING HAS
 * CLAIMED is a meeting's section, and anything else is the doc's own.
 */

import type { prose } from '@claude-workspaces/core';
import { MEETING_NOTES_HEADING } from './notes-doc-access.ts';

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

/** Whether anything at all sits under the doc's last notes heading. An empty
 *  section fits every topic, which is the case that shipped first. */
export function notesSectionIsEmpty(outline: readonly prose.OutlineEntry[]): boolean {
  const at = lastNotesHeadingIndex(outline);
  if (at < 0) return false;
  return at === outline.length - 1;
}

/**
 * Whether the doc's existing notes section is one new minutes may write into.
 *
 * `claimed` is every heading block id that a meeting has recorded as its
 * section on this doc — the in-process memory's own adoptions plus whatever
 * the heading store holds from earlier meetings and earlier processes. A
 * caller with no such record passes an empty set, which is the honest state
 * for a note-taker built without a store: it can only see the doc.
 *
 * `true` on a doc with NO notes heading as well: there is nothing to be
 * stranded by and nothing to write into by mistake, so the composer opens the
 * section itself exactly as it always has.
 */
export function notesSectionFits(
  outline: readonly prose.OutlineEntry[],
  claimed: ReadonlySet<string> = new Set(),
): boolean {
  const at = lastNotesHeadingIndex(outline);
  if (at < 0) return true;
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
  if (at === outline.length - 1) return true;
  const id = outline[at]?.id;
  // A heading a meeting has already claimed AND WRITTEN UNDER is a meeting's
  // record, whatever the blocks are currently attributed to. This is the
  // clause that survives `releaseNotesAuthorship`.
  if (id !== undefined && claimed.has(id)) return false;
  for (let i = at + 1; i < outline.length; i++) {
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
