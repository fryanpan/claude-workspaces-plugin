/**
 * Opening a slot in front of a block, so a heading can be written ABOVE the
 * notes it names rather than below them.
 *
 * WHY THIS EXISTS. Every insert the note-taker had landed at an END:
 * `insert_at_end` at the end of the document, `insert_under_heading` at
 * `sectionEndIndex` — the end of the named section. So a heading could be
 * created and never PLACED. Asked to break a topic that had swallowed half an
 * hour, the model could write `### Ferry timetable`, but only underneath the
 * twenty-nine minutes of bullets it was meant to head; the run above it
 * stopped growing and was never repaired. That is the gap this closes, and it
 * is a gap in the EDITS, not in the prompt: no wording reaches a position the
 * ops cannot express.
 *
 * WHY IT MOVES NOTHING. A block's topic is read positionally — `readOutline`
 * gives each entry the id of the nearest heading ABOVE it — so a heading
 * inserted in front of a run re-parents every bullet from there to the end of
 * the section by arriving, without touching one of them. The bullets keep
 * their words character for character, their inline marks, their block ids
 * and their comment threads, because nothing rewrote them. This is the same
 * law `prose-nest.ts` holds a move to, got for free by not moving at all.
 *
 * WHAT IT DOES DISTURB, AND THE ONE RULE THAT FOLLOWS. Top-level blocks sit in
 * the fragment, but bullets sit inside a `bulletList`, so a slot in the middle
 * of a run means SPLITTING that list in two. Yjs cannot move an integrated
 * element, so the tail is cloned and the originals deleted — exactly the
 * mechanic, and exactly the hazard, that `nestBlocksUnderLead` documents. So
 * the tail has to be ours to carry: one bullet in it that a person owns and
 * the split is refused, and the note-taker is left with a topic a little
 * longer than asked rather than a person's line cloned out from under their
 * cursor. A slot that needs no split — the first item of a list, or a
 * top-level block — asks nobody, because nothing is disturbed.
 */

import * as Y from 'yjs';
import { readBlockAuthor, setBlockAuthor } from './prose-identity.ts';
import { everyListItemIsOurs } from './prose-nest.ts';

/** Why a slot could not be opened, in the words the batch outcome reports. */
export type SplitBeforeError = 'unknown-block' | 'nested-item' | 'not-yours';

export interface SplitBeforeResult {
  /** Index in the fragment the caller may insert at. Absent on an error. */
  index?: number;
  error?: SplitBeforeError;
}

function isList(el: unknown): el is Y.XmlElement {
  return (
    el instanceof Y.XmlElement && (el.nodeName === 'bulletList' || el.nodeName === 'orderedList')
  );
}

/**
 * Open a slot immediately in front of `target`, splitting its list when
 * `target` is not the first bullet in one, and return the fragment index to
 * insert at.
 *
 * `moveOthers` lifts the ownership rule for the end-of-meeting tidy-up, whose
 * standing licence is that structure is free and words are not — the same
 * flag, and the same reason, as the one `nestBlocksUnderLead` takes.
 */
export function splitBeforeBlock(
  fragment: Y.XmlFragment,
  target: Y.XmlElement,
  author: string,
  moveOthers = false,
): SplitBeforeResult {
  const tops = fragment.toArray() as (Y.XmlElement | Y.XmlText)[];

  // A block that sits in the fragment itself needs no split: the slot in
  // front of it is already a position.
  const direct = tops.indexOf(target);
  if (direct >= 0) return { index: direct };

  const list = target.parent;
  if (!isList(list)) return { error: 'unknown-block' };
  const listAt = tops.indexOf(list);
  // A SUB-BULLET IS NOT A TOPIC BOUNDARY. Splitting a nested list would leave
  // a heading inside a list item, which serializes back as neither a heading
  // nor a bullet. The model is told to name a top-level bullet; this is what
  // happens when it names one anyway.
  if (listAt < 0) return { error: 'nested-item' };

  const items = list.toArray() as (Y.XmlElement | Y.XmlText)[];
  const at = items.indexOf(target);
  if (at < 0) return { error: 'unknown-block' };
  // The first bullet of a list: the slot in front of the LIST is the slot in
  // front of it, and nothing has to be carried anywhere.
  if (at === 0) return { index: listAt };

  const tail = items.slice(at).filter((el): el is Y.XmlElement => el instanceof Y.XmlElement);
  if (!moveOthers) {
    for (const el of tail) {
      if (el.nodeName !== 'listItem') continue;
      if (readBlockAuthor(el) !== author) return { error: 'not-yours' };
      // AND EVERYTHING UNDER IT, because the carry is a clone of the whole
      // subtree — a bullet of ours holding a person's reply takes their words
      // along with it. Same predicate as the reach in `prose-nest.ts`.
      if (!everyListItemIsOurs(el, author)) return { error: 'not-yours' };
    }
  }

  // Clone BEFORE the delete: a deleted element's content is no longer
  // readable, so this order is the difference between splitting a list and
  // losing its second half.
  const copies = tail.map((el) => el.clone());
  list.delete(at, items.length - at);
  const moved = new Y.XmlElement(list.nodeName);
  moved.insert(0, copies);
  const held = readBlockAuthor(list);
  if (held !== undefined) setBlockAuthor(moved, held);
  fragment.insert(listAt + 1, [moved]);
  return { index: listAt + 1 };
}
