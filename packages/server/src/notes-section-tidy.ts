/**
 * The two shapes a notes section is left in that nobody wrote and nobody
 * wants: an EMPTY PARAGRAPH under the heading, and the SAME TOPIC HEADING
 * TWICE in a row.
 *
 * Both were on Bryan's 2026-09-11 doc. Under the `## Meeting notes` heading
 * sat two empty paragraphs, and a little further down `### Note-taker
 * performance` appeared twice with bullets under each. Neither is something a
 * prompt can be asked to stop doing reliably — a model that opens a topic it
 * already opened is answering a tick that could not see the whole section,
 * and an empty paragraph has no author to argue with at all — so this is the
 * repair, run after the pass that had the last word on the section.
 *
 * WHY IT WRITES THE DOC DIRECTLY rather than composing block edits. A block
 * edit reaches `applyBlockEdits` as the note-taker, and a delete naming a
 * block the doc does not record as the note-taker's own becomes a SUGGESTION
 * — the right answer for a line somebody wrote, and no answer at all for a
 * blank line: it would leave the blank exactly where it was and put a redline
 * on it. Authorship is also gone by the time a second recording reads the
 * section, so nothing here could rely on it.
 *
 * WHAT IT WILL NOT TOUCH, and the list is short because the edits are:
 *
 * - **Anything with words in it.** An empty paragraph is a paragraph that
 *   serializes to nothing at all. A line holding `&nbsp;`, a space somebody
 *   typed, an image — all words as far as this is concerned, all kept.
 * - **A block a comment is anchored in.** Deleting one breaks the thread, and
 *   a thread anchored in a blank line is somebody having said something about
 *   that spot.
 * - **The section heading, and anything outside the section.** The span is
 *   the heading's own element and the blocks under it, stopping at the next
 *   heading at its level or above.
 * - **A topic heading that is not a REPEAT OF THE ONE ABOVE IT.** Dropping a
 *   heading hands its bullets to whatever heading precedes them, so it is
 *   only safe where that heading is the same topic. Two `### Ferry timetable`
 *   headings with `### Slipway costs` between them stay as they are: merging
 *   them means moving bullets, which re-creates them under new ids and takes
 *   every comment anchor in them with it. The duplicate that is worth
 *   repairing is the one a tick opens straight after the topic it duplicates,
 *   which is the one that was measured.
 *
 * Every bullet survives either way: the only element removed is the heading
 * itself, and the lines under it become the lines under the heading above.
 */

import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { topicKey } from './notes-quality.ts';

/** What one tidy changed. Both numbers are zero for the ordinary section,
 *  which is what a caller logs nothing for. */
export interface NotesSectionTidyResult {
  /** Empty paragraphs removed. */
  blanks: number;
  /** Duplicate topic headings folded into the topic above them. */
  merged: number;
}

/** A heading's level, or `undefined` for a block that is not one. */
function levelOf(el: Y.XmlElement): number | undefined {
  if (el.nodeName !== 'heading') return undefined;
  const n = Number(el.getAttribute('level'));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** The words a block holds, as a reader sees them. */
function textOf(el: Y.XmlElement): string {
  try {
    return prose
      .serializeBlockToMarkdown(el)
      .replace(/^#{1,6}\s*/, '')
      .trim();
  } catch {
    // A block that will not serialize is one this repair cannot judge, and
    // an unjudged block is a kept block.
    return 'unreadable';
  }
}

/**
 * Repair the section `headingId` opens, in place.
 *
 * Never throws: it runs after a pass that has already written the notes, and
 * a repair is worth strictly less than what it is repairing. A doc that is
 * gone, a heading that is not there and a fragment that will not read are all
 * "nothing to tidy".
 */
export function tidyNotesSection(
  ydoc: Y.Doc,
  headingId: string,
  commented: ReadonlySet<string> = new Set(),
): NotesSectionTidyResult {
  let top: Y.XmlElement[];
  try {
    top = prose.getProseFragment(ydoc).toArray() as Y.XmlElement[];
  } catch {
    return { blanks: 0, merged: 0 };
  }
  const start = top.findIndex((el) => prose.readBlockId(el) === headingId);
  if (start < 0) return { blanks: 0, merged: 0 };
  const openLevel = levelOf(top[start] as Y.XmlElement) ?? 2;

  const drop: number[] = [];
  let blanks = 0;
  let merged = 0;
  // The last topic heading kept, so a repeat is compared with the heading it
  // would be folded into rather than with any earlier one.
  let lastTopic: string | undefined;
  for (let i = start + 1; i < top.length; i++) {
    const el = top[i] as Y.XmlElement;
    const level = levelOf(el);
    if (level !== undefined && level <= openLevel) break;
    const id = prose.readBlockId(el);
    if (id !== undefined && commented.has(id)) {
      if (level !== undefined) lastTopic = topicKey(textOf(el));
      continue;
    }
    if (level !== undefined) {
      const key = topicKey(textOf(el));
      // An empty heading is not a topic and not a repeat of one either; it
      // falls through to the blank check below.
      if (key.length > 0) {
        if (key === lastTopic) {
          drop.push(i);
          merged++;
          continue;
        }
        lastTopic = key;
        continue;
      }
    }
    if (textOf(el).length === 0) {
      drop.push(i);
      blanks++;
    }
  }
  if (drop.length === 0) return { blanks: 0, merged: 0 };
  ydoc.transact(() => {
    // Descending, so an index not yet used still names the block it named
    // when the walk chose it.
    for (let i = drop.length - 1; i >= 0; i--) {
      prose.getProseFragment(ydoc).delete(drop[i] as number, 1);
    }
  }, 'agent');
  return { blanks, merged };
}
