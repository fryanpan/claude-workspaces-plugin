/**
 * Proposing a change to whole blocks, rather than to a run of text.
 *
 * `suggestRewriteRange` proposes inside ONE block: the words it strikes and
 * the words it offers share a paragraph. That is the wrong shape for an edit
 * addressed to a block. A replacement that is itself several blocks — a
 * heading, a list, a fenced sample — has nowhere to go inside one paragraph
 * except as characters, so accepting it wrote `###` and `- ` into the doc as
 * literal text, and a replacement aimed at a code block put all of that
 * inside the code.
 *
 * So a block proposal is two sets of blocks under one sid: every character
 * of the target marked `suggestDelete`, and the replacement built as real
 * blocks beside it with every character marked `suggestInsert`. Resolving it
 * needs nothing new from `suggest-ops.ts` — accepting deletes the struck text
 * and removes the blocks that empties, rejecting deletes the offered text and
 * removes those blocks the same way. It is the shape that machinery already
 * resolves, written over more than one block.
 *
 * A block any of whose text is already somebody's proposal is refused, not
 * proposed around. Striking only its unmarked words would report a
 * whole-block replacement while accepting it left the other proposal's words
 * standing beside the replacement; re-marking them would take them away from
 * that proposal, so answering this one would quietly answer the other.
 */
import * as Y from 'yjs';
import { type SuggestionAuthor, newSid } from './suggest-ops.ts';
import { SUGGEST_DELETE_MARK, SUGGEST_INSERT_MARK, type SuggestionAttrs } from './suggest.ts';

/** One stretch of a text node, to be struck. */
export interface TextRun {
  node: Y.XmlText;
  offset: number;
  length: number;
}

/** Every Y.XmlText under `el`, in document order. */
function textNodes(el: Y.XmlElement): Y.XmlText[] {
  const out: Y.XmlText[] = [];
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) out.push(child);
    else if (child instanceof Y.XmlElement) out.push(...textNodes(child));
  }
  return out;
}

/**
 * Every run of text under `el`, for a proposal to strike — or `null` when any
 * of it already carries a suggestion mark (see the header). Empty for a block
 * with no text (a rule, an image).
 */
export function blockText(el: Y.XmlElement): TextRun[] | null {
  const runs: TextRun[] = [];
  for (const node of textNodes(el)) {
    let offset = 0;
    for (const op of node.toDelta() as Array<{
      insert?: unknown;
      attributes?: Record<string, unknown>;
    }>) {
      if (typeof op.insert !== 'string') continue;
      const length = op.insert.length;
      const attrs = op.attributes ?? {};
      if (attrs[SUGGEST_INSERT_MARK] != null || attrs[SUGGEST_DELETE_MARK] != null) return null;
      if (length > 0) runs.push({ node, offset, length });
      offset += length;
    }
  }
  return runs;
}

/**
 * Whether every block in `el`, at every depth, holds text a mark can sit on.
 * A blockquote with words in it can still hold a rule, and that rule is what
 * would reach the file unasked; so a block passes only when it has text of
 * its own or child blocks, and every child block passes too.
 */
function markableThroughout(el: Y.XmlElement): boolean {
  const kids = el.toArray();
  const blocks = kids.filter((k): k is Y.XmlElement => k instanceof Y.XmlElement);
  const hasText = kids.some((k) => k instanceof Y.XmlText && k.length > 0);
  if (!hasText && blocks.length === 0) return false;
  return blocks.every(markableThroughout);
}

/**
 * Whether every offered block can carry the proposal. When one cannot, remove
 * them ALL and answer false: the replacement cannot be proposed as written.
 *
 * A mark needs a character to sit on. A horizontal rule or an image in the
 * replacement could carry no `suggestInsert`, so it would serialize as
 * accepted content on the next write-back and survive a reject — a change
 * nobody agreed to. Dropping just that block would be no better: accepting
 * would then write part of what the caller asked for and call it done.
 */
export function offerWhole(offered: readonly Y.XmlElement[]): boolean {
  if (offered.every(markableThroughout)) return true;
  for (const el of offered) {
    const parent = el.parent as Y.XmlFragment | Y.XmlElement | null;
    const idx = parent ? (parent.toArray() as unknown[]).indexOf(el) : -1;
    if (parent && idx >= 0) parent.delete(idx, 1);
  }
  return false;
}

/**
 * Mark `struck` for removal and every character of `offered` as its
 * replacement, under one new sid. Call inside the caller's transaction, after
 * `offered` is in the doc — a mark can only be written on integrated text.
 */
export function markBlockProposal(
  struck: readonly TextRun[],
  offered: readonly Y.XmlElement[],
  author: SuggestionAuthor,
  ts: number = Date.now(),
): string {
  const sid = newSid();
  const attrs: SuggestionAttrs = {
    sid,
    authorId: author.id,
    authorName: author.name,
    authorColor: author.color,
    ts,
  };
  for (const run of struck) {
    run.node.format(run.offset, run.length, { [SUGGEST_DELETE_MARK]: attrs });
  }
  for (const el of offered) {
    for (const node of textNodes(el)) {
      if (node.length > 0) node.format(0, node.length, { [SUGGEST_INSERT_MARK]: attrs });
    }
  }
  return sid;
}
