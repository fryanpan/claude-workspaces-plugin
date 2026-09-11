/**
 * Moving bullets UNDER one of their neighbours, without rewriting any of them.
 *
 * WHY THIS IS NOT A `replace_block`. A topic that has grown past the flat-run
 * bar is regrouped by gathering its points under short lead bullets, and the
 * only way to express that with the edits that already existed was to
 * `replace_block` one bullet with a lead plus the others' words nested under
 * it, then `delete_block` the ones folded in. That RESTATES every folded
 * point: the model retypes the words, so a paraphrase drifts, a speaker tag
 * gets dropped, and — the part that costs a reader something they cannot get
 * back — every comment thread anchored to the old wording orphans, because
 * the text it matched is no longer anywhere in the doc.
 *
 * This op moves the blocks instead. Each one keeps its words character for
 * character, keeps its inline marks, and keeps its block id, so an edit that
 * named it a tick ago still names it. Yjs has no move primitive — an
 * integrated element cannot be re-inserted elsewhere — so the move is a
 * `clone()` and a delete of the original, which is why the thread anchors
 * still have to be recovered afterwards. They can be, and cheaply:
 * `autoReanchorDoc` re-anchors a thread whose snippet appears exactly once in
 * the doc, and a moved bullet's snippet is still exactly the text it was, one
 * level in. That recovery is what "the threads stay on their text" rests on,
 * and it only holds BECAUSE the words are not retyped.
 */

import * as Y from 'yjs';
import { isUnclaimedBlankParagraph } from './prose-fragment.ts';
import { readBlockAuthor, readBlockId, setBlockAuthor } from './prose-identity.ts';
import { findBlockById } from './prose-outline.ts';

/** Why a nest did nothing, in the words the batch outcome reports. */
export type NestBlocksError =
  | 'unknown-block'
  | 'not-a-list-item'
  | 'not-yours'
  | 'not-a-sibling'
  | 'nothing-to-nest';

export interface NestBlocksResult {
  /**
   * How many blocks ended up under the lead.
   *
   * Zero carries an error EXCEPT when every block named is already under the
   * lead: the end state the caller asked for holds, nothing had to move, and
   * calling that a failure is what made a note-taker re-issue the same
   * regroup on ten consecutive ticks of a measured hour.
   */
  moved: number;
  error?: NestBlocksError;
}

export interface NestBlocksOptions {
  /** The bullet the others go under. Stays exactly where it is. */
  leadBlockId: string;
  /** The bullets to move, named in any order; they move in DOCUMENT order. */
  blockIds: readonly string[];
  /** Only blocks still marked as this author's may be moved. */
  author: string;
}

function isList(el: unknown): el is Y.XmlElement {
  return (
    el instanceof Y.XmlElement && (el.nodeName === 'bulletList' || el.nodeName === 'orderedList')
  );
}

/**
 * The list already nested inside `lead`, or a fresh one appended to it.
 *
 * Appended rather than prepended: a lead that already has sub-points gets the
 * new ones after the ones it had, which is the order the meeting said them
 * in. A `listItem` holds its own paragraph first and its nested lists after,
 * so appending is also the only position that serializes back to markdown as
 * nesting rather than as a sibling list.
 */
function nestedListOf(lead: Y.XmlElement, author: string): Y.XmlElement {
  const children = lead.toArray();
  const last = children[children.length - 1];
  if (isList(last)) return last;
  const list = new Y.XmlElement('bulletList');
  lead.insert(lead.length, [list]);
  setBlockAuthor(list, author);
  return list;
}

/**
 * The lists a regroup may gather from: the lead's own, and the sibling lists
 * a note the note-taker itself wrote has cut it off from.
 *
 * WHY THIS EXISTS. A topic's bullets are one `bulletList` only for as long as
 * every note under that heading is a bullet. The moment the note-taker writes
 * anything else there — a paragraph note, or a `1.` where the instructions
 * ask for a `- ` — the next insert lands after it and opens a SECOND list.
 * `readOutline` reports both sets identically (`bullet`, depth 0, the same
 * `underHeadingId`), so nothing the model is shown says the split happened,
 * and a `nest_blocks` naming a lead from one list and members from the other
 * found no sibling to move and answered `nothing-to-nest` — every tick, for
 * as long as the topic stayed over the flat-run bar. Measured on an hour of
 * EN2001a: seventeen of the run's twenty-four failed edits, and ten of them
 * the SAME regroup re-issued tick after tick.
 *
 * WHAT IT WILL NOT CROSS. A heading (the next topic is not this one's to
 * regroup), a list of the other kind, and any block that is not the
 * note-taker's own — a person's paragraph in the middle of the notes stops
 * the reach, which leaves their writing where they put it and the topic a
 * little flatter than asked. A blank unclaimed paragraph is the browser's
 * trailing node and is stepped over, exactly as `precedingBlock` steps over
 * it.
 *
 * Returned in document order, so the members gathered from them stay in the
 * order the meeting said them.
 */
function reachableLists(list: Y.XmlElement, author: string): Y.XmlElement[] {
  const parent = (list.parent as Y.XmlFragment | Y.XmlElement | null) ?? null;
  if (parent === null) return [list];
  const siblings = parent.toArray() as (Y.XmlElement | Y.XmlText)[];
  const at = siblings.indexOf(list);
  if (at < 0) return [list];
  const out = [list];
  const crossable = (el: Y.XmlElement | Y.XmlText | undefined): boolean => {
    if (isUnclaimedBlankParagraph(el)) return true;
    if (!(el instanceof Y.XmlElement)) return false;
    if (el.nodeName === 'heading') return false;
    // A LIST IS JUDGED BY ITS ITEMS, NOT BY ITS OWN MARK. A list container
    // carries `cwAuthor` only when this agent's own insert built it; one that
    // came back off disk carries nothing, because markdown has nowhere to put
    // the attribute. Its items are the thing a reach would step over, so they
    // are what decides.
    if (isList(el)) {
      const items = (el.toArray() as unknown[]).filter(
        (kid): kid is Y.XmlElement => kid instanceof Y.XmlElement && kid.nodeName === 'listItem',
      );
      return items.length > 0 && items.every((kid) => readBlockAuthor(kid) === author);
    }
    return readBlockAuthor(el) === author;
  };
  for (const step of [-1, 1]) {
    for (let i = at + step; i >= 0 && i < siblings.length; i += step) {
      const el = siblings[i];
      // A same-kind list is gathered from AND stepped over, on the same
      // terms: a person's bullet inside it stops the reach beyond it, so
      // nothing this agent owns is moved across something it does not.
      if (isList(el) && el.nodeName === list.nodeName) out.push(el);
      if (!crossable(el)) break;
    }
  }
  return out.sort((a, b) => siblings.indexOf(a) - siblings.indexOf(b));
}

/** Whether `el` sits anywhere inside `ancestor`. */
function isInside(el: Y.XmlElement, ancestor: Y.XmlElement): boolean {
  let node = el.parent as Y.XmlElement | Y.XmlFragment | null;
  while (node != null) {
    if (node === ancestor) return true;
    node = (node as { parent?: Y.XmlElement | Y.XmlFragment | null }).parent ?? null;
  }
  return false;
}

/**
 * Move `blockIds` under `leadBlockId` as sub-bullets, in place.
 *
 * Refuses outright — moving nothing — when the LEAD is unusable, because a
 * regroup with no lead has no shape to fall back to. A named member that
 * cannot move (gone, a person's, not a sibling) is skipped instead: the
 * bullet simply stays where it is, which leaves the notes complete and the
 * topic a little flatter than asked. Nothing is ever deleted outright, so a
 * point present before the move is present after it either way.
 */
export function nestBlocksUnderLead(
  fragment: Y.XmlFragment,
  opts: NestBlocksOptions,
): NestBlocksResult {
  const lead = findBlockById(fragment, opts.leadBlockId);
  if (!lead) return { moved: 0, error: 'unknown-block' };
  if (lead.nodeName !== 'listItem') return { moved: 0, error: 'not-a-list-item' };
  if (readBlockAuthor(lead) !== opts.author) return { moved: 0, error: 'not-yours' };
  const list = lead.parent;
  if (!isList(list)) return { moved: 0, error: 'not-a-sibling' };

  // Document order, not the order the ids were named: a model listing them
  // backwards must not silently reverse the meeting.
  //
  // ACROSS THE LEAD'S OWN LIST AND THE ONES A NOTE OF ITS OWN CUT IT OFF
  // FROM — see {@link reachableLists}. A bullet the outline reports as this
  // lead's sibling has to BE reachable, or the regroup the notes are asked
  // for cannot be made from what the model is shown.
  const wanted = new Set(opts.blockIds);
  const members: Array<{ el: Y.XmlElement; from: Y.XmlElement }> = [];
  for (const from of reachableLists(list, opts.author)) {
    for (const el of from.toArray() as unknown[]) {
      if (!(el instanceof Y.XmlElement)) continue;
      if (el === lead || el.nodeName !== 'listItem') continue;
      if (!wanted.has(readBlockId(el) ?? ' ')) continue;
      if (readBlockAuthor(el) !== opts.author) continue;
      members.push({ el, from });
    }
  }
  if (members.length === 0) {
    // ALREADY DONE IS NOT A FAILURE. A model that cannot see how deep a
    // bullet already sits re-asks for a regroup it made ticks ago; answering
    // `nothing-to-nest` turns that into a failed edit, and on a batch of
    // nothing but regroups into a write that landed nothing at all.
    const named = opts.blockIds
      .map((id) => findBlockById(fragment, id))
      .filter((el): el is Y.XmlElement => el !== null && el !== undefined);
    if (named.length > 0 && named.every((el) => isInside(el, lead))) return { moved: 0 };
    return { moved: 0, error: 'nothing-to-nest' };
  }

  const nested = nestedListOf(lead, opts.author);
  let moved = 0;
  for (const { el, from } of members) {
    const at = (from.toArray() as unknown[]).indexOf(el);
    if (at < 0) continue;
    // Clone BEFORE the delete: a deleted element's content is no longer
    // readable, so the order here is the difference between moving a bullet
    // and losing one.
    const copy = el.clone();
    from.delete(at, 1);
    nested.insert(nested.length, [copy]);
    moved++;
    // A list the regroup emptied is furniture, and leaving it behind would
    // put a blank list between two notes for the rest of the meeting.
    if (from !== list && from.length === 0) {
      const holder = (from.parent as Y.XmlFragment | Y.XmlElement | null) ?? null;
      const idx = holder === null ? -1 : (holder.toArray() as unknown[]).indexOf(from);
      if (holder !== null && idx >= 0) holder.delete(idx, 1);
    }
  }
  return moved === 0 ? { moved: 0, error: 'nothing-to-nest' } : { moved };
}

/**
 * The whole `nest_blocks` op as one batch outcome, so the applier's switch is
 * a dispatch rather than a second home for what a nest means.
 *
 * NO SUGGESTION PATH, unlike a replace of somebody else's block. A move
 * proposes no words, so there is nothing for a person to read a redline of; a
 * lead that is not the note-taker's own is simply refused.
 */
export function nestBlocksOutcome(
  fragment: Y.XmlFragment,
  edit: { leadBlockId: string; blockIds: readonly string[] },
  author: string,
): { op: 'nest_blocks'; status: 'applied' | 'failed'; error?: NestBlocksError } {
  const res = nestBlocksUnderLead(fragment, {
    leadBlockId: edit.leadBlockId,
    blockIds: edit.blockIds,
    author,
  });
  return res.error === undefined
    ? { op: 'nest_blocks', status: 'applied' }
    : { op: 'nest_blocks', status: 'failed', error: res.error };
}
