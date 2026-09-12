/**
 * The three shapes a notes section is left in that nobody wrote and nobody
 * wants: an EMPTY PARAGRAPH under the heading, the SAME TOPIC HEADING TWICE
 * in a row, and an EMPTY BULLET the note-taker wrote.
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
 * - **A bullet that is not the note-taker's own.** An empty bullet is what a
 *   person has under the cursor between pressing Enter and typing the first
 *   word, and a live meeting is when that is most likely — so only a bullet
 *   still carrying the note-taker's authorship is removed, and a bullet with
 *   a nested list under it is kept whatever its own line says. The empty
 *   bullet this exists for is the one measured on 2026-09-11: a section that
 *   opened with a blank line carrying the fresh-note tint and kept it for the
 *   rest of the recording. `notes-edit-guard.ts` RULE 3 is what stops one
 *   being written; this is what clears one already there.
 * - **A block a comment is anchored in.** Deleting one breaks the thread, and
 *   a thread anchored in a blank line is somebody having said something about
 *   that spot.
 * - **A block holding a suggestion nobody has answered yet.** A proposal on
 *   somebody's own line puts its OFFERED words in a new bullet of the
 *   note-taker's, and a suggested insertion is not serialized — so that
 *   bullet reads as an authored empty one and is exactly the shape this
 *   repair removes. Deleting it would throw away the offer while leaving the
 *   strike-through on the line it was made about.
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

import { SUGGEST_DELETE_MARK, SUGGEST_INSERT_MARK, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { topicKey } from './notes-quality.ts';

/** What one tidy changed. Every number is zero for the ordinary section,
 *  which is what a caller logs nothing for. */
export interface NotesSectionTidyResult {
  /** Empty paragraphs removed. */
  blanks: number;
  /** Duplicate topic headings folded into the topic above them. */
  merged: number;
  /** The note-taker's own bullets with no words in them, removed. */
  bullets: number;
}

/** Any letter or digit — what tells a note from a list marker. */
const WORD = /[\p{L}\p{N}]/u;

/** The answer for a section with nothing to repair, which is nearly all of
 *  them. */
const NOTHING: NotesSectionTidyResult = { blanks: 0, merged: 0, bullets: 0 };

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
  commented: ReadonlySet<string> | (() => ReadonlySet<string>) = new Set(),
  opts: { blanks?: boolean; bulletsAuthoredBy?: string } = {},
): NotesSectionTidyResult {
  // READ ONLY IF SOMETHING IS ABOUT TO BE DROPPED. Finding the comments means
  // walking the whole document's text, and this runs after every tick of
  // every meeting, where the ordinary answer is that there is nothing to
  // repair at all.
  let threads: ReadonlySet<string> | undefined;
  const commentedNow = (): ReadonlySet<string> => {
    if (threads === undefined) threads = typeof commented === 'function' ? commented() : commented;
    return threads;
  };
  const dropBlanks = opts.blanks ?? true;
  const bulletAuthor = opts.bulletsAuthoredBy;
  let top: Y.XmlElement[];
  try {
    top = prose.getProseFragment(ydoc).toArray() as Y.XmlElement[];
  } catch {
    return NOTHING;
  }
  const start = top.findIndex((el) => prose.readBlockId(el) === headingId);
  if (start < 0) return NOTHING;
  const openLevel = levelOf(top[start] as Y.XmlElement) ?? 2;

  const drop: number[] = [];
  /** Bullets to remove from a list that is keeping its other items, as the
   *  list element and the indexes inside it. */
  const dropItems: Array<{ list: Y.XmlElement; at: number[] }> = [];
  let blanks = 0;
  let merged = 0;
  let bullets = 0;
  // The last topic heading kept — its words and its level — so a repeat is
  // compared with the heading it would be folded into rather than with any
  // earlier one.
  let lastTopic: { key: string; level: number } | undefined;
  for (let i = start + 1; i < top.length; i++) {
    const el = top[i] as Y.XmlElement;
    const level = levelOf(el);
    if (level !== undefined && level <= openLevel) break;
    const id = prose.readBlockId(el);
    const commentedHere = (): boolean => id !== undefined && commentedNow().has(id);
    if (level !== undefined) {
      const key = topicKey(textOf(el));
      // AND AT THE SAME LEVEL. `### Ferry timetable` followed by `#### Ferry
      // timetable` is a sub-topic somebody nested, not a topic opened twice,
      // and dropping the deeper one flattens a hierarchy rather than folding
      // a repeat.
      if (key.length > 0 && key === lastTopic?.key && level === lastTopic.level) {
        if (!commentedHere()) {
          drop.push(i);
          merged++;
          continue;
        }
      }
      // An empty heading is a heading, and this repair removes only empty
      // PARAGRAPHS: a heading somebody has not finished typing is structure
      // they put there, and deleting it moves their words under the topic
      // above.
      lastTopic = { key, level };
      continue;
    }
    if (dropBlanks && el.nodeName === 'paragraph' && textOf(el).length === 0 && !commentedHere()) {
      drop.push(i);
      blanks++;
      continue;
    }
    if (
      bulletAuthor !== undefined &&
      (el.nodeName === 'bulletList' || el.nodeName === 'orderedList')
    ) {
      const empties = wordlessItems(el, bulletAuthor, commentedNow);
      if (empties.length === 0) continue;
      bullets += empties.length;
      if (empties.length === itemCount(el)) drop.push(i);
      else dropItems.push({ list: el, at: empties });
    }
  }
  if (drop.length === 0 && dropItems.length === 0) return NOTHING;
  ydoc.transact(() => {
    // The items first: removing one changes no TOP-LEVEL index, while
    // removing a list would invalidate the element the items hang off.
    for (const { list, at } of dropItems) {
      for (let k = at.length - 1; k >= 0; k--) list.delete(at[k] as number, 1);
    }
    // Descending, so an index not yet used still names the block it named
    // when the walk chose it.
    for (let i = drop.length - 1; i >= 0; i--) {
      prose.getProseFragment(ydoc).delete(drop[i] as number, 1);
    }
  }, 'agent');
  return { blanks, merged, bullets };
}

/** How many children this list holds, elements and all. */
function itemCount(list: Y.XmlElement): number {
  return list.length;
}

/**
 * The indexes of this list's own items that carry no words and belong to the
 * note-taker.
 *
 * AUTHORSHIP IS THE WHOLE SAFETY OF IT. A person pressing Enter in the notes
 * section has an empty bullet under their cursor for as long as it takes them
 * to type the next word, and a live meeting is exactly when that is true —
 * so a rule that judged emptiness alone would delete a line somebody was
 * writing. A block a person has touched carries no author at all
 * (`clearAuthorshipOnPersonEdit`), so an authored empty bullet is one this
 * agent wrote and nobody has been near.
 *
 * AND NOTHING NESTED UNDER IT. A bullet with no words of its own but a list
 * under it is a group's lead line; dropping it would take its children with
 * it. `WORD` over the item's whole serialization answers both questions at
 * once — a nested child's words are in it.
 *
 * AND NO UNANSWERED SUGGESTION IN IT. Serialization leaves suggested-insert
 * text out, so the bullet a pending proposal keeps its offered words in
 * serializes to nothing and carries the note-taker's authorship — the exact
 * shape of the bug this repairs. Measured: with only the two rules above, a
 * cleanup pass that offered on a person's line lost its offer and left the
 * strike-through standing.
 */
function wordlessItems(
  list: Y.XmlElement,
  author: string,
  commented: () => ReadonlySet<string>,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list.get(i);
    if (!(item instanceof Y.XmlElement) || item.nodeName !== 'listItem') continue;
    if (prose.readBlockAuthor(item) !== author) continue;
    let text: string;
    try {
      text = prose.serializeBlockToMarkdown(item);
    } catch {
      continue;
    }
    if (WORD.test(text)) continue;
    if (holdsASuggestion(item)) continue;
    const id = prose.readBlockId(item);
    if (id !== undefined && commented().has(id)) continue;
    out.push(i);
  }
  return out;
}

/** Whether any text under this block carries an unanswered suggestion mark —
 *  the offered words of a proposal, or the strike on what it would replace. */
function holdsASuggestion(block: Y.XmlElement): boolean {
  const stack: Array<Y.XmlElement | Y.XmlText> = [block];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node instanceof Y.XmlText) {
      for (const op of node.toDelta() as Array<{ attributes?: Record<string, unknown> }>) {
        const marks = op.attributes;
        if (marks === undefined) continue;
        if (marks[SUGGEST_INSERT_MARK] != null || marks[SUGGEST_DELETE_MARK] != null) return true;
      }
      continue;
    }
    if (node === undefined) continue;
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) stack.push(child);
    }
  }
  return false;
}
