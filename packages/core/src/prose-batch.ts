/**
 * A batch of block-addressed edits, applied in ONE Yjs transaction.
 *
 * The rest of the edit family is one verb per call, which is right for an
 * agent making one change. It is wrong for an agent that composes a handful
 * of small changes at once — a note-taker adding two bullets and rewriting
 * a third — because each call is a transaction of its own, so a reader
 * watching the doc sees the batch arrive in pieces and a failure halfway
 * leaves half of it applied.
 *
 * So this file takes a list of edits addressed by BLOCK ID (see
 * `prose-outline.ts`) and applies them together. Two rules make the result
 * predictable:
 *
 * - **Authorship decides direct-vs-proposal.** An edit that replaces or
 *   deletes a block still marked as the caller's own applies directly.
 *   Anything else — a block a person wrote, or one of the caller's that a
 *   person has since touched, which is the same thing after
 *   `clearAuthorshipOnPersonEdit` has run — becomes a block proposal
 *   (`suggest-blocks.ts`): the words struck, the replacement offered as
 *   blocks beside them. Nothing this file does can destroy words the caller
 *   did not write.
 * - **A list is grown, never twinned.** Inserting bullets where the target
 *   already ends in a list of the same type puts the new items INTO that
 *   list. Splicing a second list in beside it is what made the browser's
 *   list-join plugin re-create the agent's own bullets, and re-created
 *   bullets are bullets the agent can no longer find.
 */
import * as Y from 'yjs';
import { getProseFragment, headingLevelOf, precedingBlock } from './prose-fragment.ts';
import {
  BLOCK_AUTHOR_ATTR,
  BLOCK_ID_ATTR,
  readBlockAuthor,
  readBlockId,
} from './prose-identity.ts';
import { parseMarkdownBlocks } from './prose-markdown.ts';
import { type NestBlocksError, nestBlocksOutcome } from './prose-nest.ts';
import { addressableBlocks, claimSubtree, findBlockById, newBlockId } from './prose-outline.ts';
import { blockText, markBlockProposal, offerWhole } from './suggest-blocks.ts';
import type { SuggestionAuthor } from './suggest-ops.ts';

/** One edit, addressed by block id. */
export type BlockEdit =
  | { op: 'insert_under_heading'; headingId: string; markdown: string }
  | { op: 'insert_at_end'; markdown: string }
  | { op: 'replace_block'; blockId: string; markdown: string }
  | { op: 'delete_block'; blockId: string }
  | { op: 'nest_blocks'; leadBlockId: string; blockIds: readonly string[] };

export type BlockEditOp = BlockEdit['op'];

/** Why one edit of a batch did nothing. */
export type BlockEditError =
  | 'unknown-block'
  | 'not-a-heading'
  | 'parse-failed'
  | 'empty'
  | 'no-range'
  | 'suggest-failed'
  | NestBlocksError;

export interface BlockEditOutcome {
  op: BlockEditOp;
  /** `applied` = written directly; `suggested` = proposed via suggest mode. */
  status: 'applied' | 'suggested' | 'failed';
  error?: BlockEditError;
  /** The suggestion this edit became, when it became one. */
  suggestionId?: string;
  /** What to change before retrying, when the error code alone cannot say. */
  reason?: string;
}

export interface ApplyBlockEditsResult {
  applied: number;
  suggested: number;
  failed: number;
  outcomes: BlockEditOutcome[];
}

export interface ApplyBlockEditsOptions {
  /** Agent id stamped on every block this batch inserts, and the id an
   *  existing block must carry for a replace or delete to apply directly. */
  author: string;
  /** Who a proposal is attributed to when an edit cannot apply directly. */
  suggestionAuthor: SuggestionAuthor;
  transactionOrigin?: unknown;
}

/** Give an id to anything in `fragment` that has none. Called from INSIDE
 *  the batch transaction, which is why it is not `ensureBlockIds`. */
function mintMissingIds(fragment: Y.XmlFragment): void {
  for (const el of addressableBlocks(fragment)) {
    if (readBlockId(el) === undefined) el.setAttribute(BLOCK_ID_ATTR, newBlockId());
  }
}

/** A markdown list line, e.g. `- point` or `2. point`. */
const LIST_LINE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

interface LeadingList {
  ordered: boolean;
  /** Inner markdown of each item, marker stripped and de-indented. */
  items: string[];
  /** Whatever followed the run of items. */
  rest: string;
}

/**
 * Split a leading run of top-level list items off the front of `markdown`.
 *
 * Deliberately a line reader rather than a round trip through the block
 * parser: a parsed-but-unintegrated `Y.XmlElement` exposes neither its
 * children nor its attributes, so there is no way to take items back out of
 * a list the parser built. Reading the lines and building the items here is
 * the only route to putting them inside a list that already exists.
 */
export function splitLeadingListItems(markdown: string): LeadingList | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const first = lines[0]?.match(LIST_LINE);
  if (!first || (first[1] ?? '').length > 0) return null;
  const ordered = /^\d/.test(first[2] ?? '');
  const items: string[] = [];
  let current: string[] | null = null;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = line.match(LIST_LINE);
    const indent = (m?.[1] ?? '').length;
    if (m && indent === 0) {
      // A switch of list type ends the run — the caller's `rest` picks it up.
      if (/^\d/.test(m[2] ?? '') !== ordered) break;
      if (current) items.push(current.join('\n'));
      current = [m[3] ?? ''];
      continue;
    }
    if (current === null) break;
    if (line.trim() === '') {
      // A blank line inside the run is only a continuation if more indented
      // content follows; otherwise the list has ended.
      const next = lines[i + 1] ?? '';
      if (next.trim() !== '' && /^\s/.test(next)) {
        current.push('');
        continue;
      }
      break;
    }
    if (!/^\s/.test(line)) break;
    current.push(line.replace(/^ {1,4}|^\t/, ''));
  }
  if (current) items.push(current.join('\n'));
  if (items.length === 0) return null;
  return { ordered, items, rest: lines.slice(i).join('\n').trim() };
}

/** Build a `listItem` element from one item's inner markdown. */
function buildListItem(inner: string): Y.XmlElement | null {
  const children = parseMarkdownBlocks(inner.trim().length > 0 ? inner : ' ');
  if (children.length === 0) return null;
  const li = new Y.XmlElement('listItem');
  li.insert(0, children);
  return li;
}

function isList(el: Y.XmlElement | Y.XmlText | undefined): el is Y.XmlElement {
  return (
    el instanceof Y.XmlElement && (el.nodeName === 'bulletList' || el.nodeName === 'orderedList')
  );
}

/**
 * Insert `markdown` into `parent` at `index`, growing a neighbouring list of
 * the same type instead of creating a second one. Returns the elements it
 * created, in document order.
 */
function insertBlocksMerging(
  parent: Y.XmlFragment | Y.XmlElement,
  index: number,
  markdown: string,
): Y.XmlElement[] {
  const created: Y.XmlElement[] = [];
  const siblings = parent.toArray() as (Y.XmlElement | Y.XmlText)[];
  const leading = splitLeadingListItems(markdown);
  let rest = markdown;
  let at = index;
  if (leading) {
    // Grow the list ENDING AT the insertion point rather than splicing a
    // second one after it: appending keeps the new points in the order they
    // were said. A mirror branch that prepended into a list AFTER the point
    // was deleted rather than fixed — nothing ever reached it (callers insert
    // at a section end or the fragment end) and it inverted the markdown.
    const wanted = leading.ordered ? 'orderedList' : 'bulletList';
    // `precedingBlock`, not `siblings[index - 1]`: it steps back over the
    // browser's trailing paragraph, which made every note open its own list.
    const before = precedingBlock(siblings, index);
    const host = isList(before) && before.nodeName === wanted ? before : null;
    if (host) {
      const items = leading.items
        .map(buildListItem)
        .filter((li): li is Y.XmlElement => li !== null);
      if (items.length > 0) {
        host.insert(host.length, items);
        created.push(...items);
      }
      // Whatever the markdown put after its items goes after them here too —
      // in FRONT of the paragraph stepped over, or a note's own detail
      // paragraph would land past it with the gap back in between.
      at = siblings.indexOf(host) + 1;
      rest = leading.rest;
    }
  }
  if (rest.trim().length === 0) return created;
  const blocks = parseMarkdownBlocks(rest);
  if (blocks.length === 0) return created;
  parent.insert(at, blocks);
  // Reading the freshly inserted elements is safe — they are integrated now.
  const after = parent.toArray() as (Y.XmlElement | Y.XmlText)[];
  for (const el of after.slice(at, at + blocks.length)) {
    if (el instanceof Y.XmlElement) created.push(el);
  }
  return created;
}

/** Insert parsed `blocks` into `parent` at `at`; return the elements written. */
function insertParsed(
  parent: Y.XmlFragment | Y.XmlElement,
  at: number,
  blocks: Y.XmlElement[],
): Y.XmlElement[] {
  parent.insert(at, blocks);
  // Reading the freshly inserted elements is safe — they are integrated now.
  return (parent.toArray() as (Y.XmlElement | Y.XmlText)[])
    .slice(at, at + blocks.length)
    .filter((el): el is Y.XmlElement => el instanceof Y.XmlElement);
}

/**
 * Put `markdown` immediately after the list `holder` — the home for the tail
 * a multi-item `replace_block` left over. A no-op when `holder` is not a list
 * or has left the doc: losing the tail is bad, but writing it into the middle
 * of somebody's list would be worse.
 */
function insertAfterList(
  fragment: Y.XmlFragment,
  holder: Y.XmlFragment | Y.XmlElement,
  markdown: string,
): Y.XmlElement[] {
  if (!(holder instanceof Y.XmlElement) || !isList(holder)) return [];
  const grand = (holder.parent as Y.XmlFragment | Y.XmlElement | null) ?? fragment;
  const at = (grand.toArray() as unknown[]).indexOf(holder) + 1;
  if (at <= 0) return [];
  const blocks = parseMarkdownBlocks(markdown);
  return blocks.length === 0 ? [] : insertParsed(grand, at, blocks);
}

/**
 * Build `markdown` into the doc at `el`: in its place (`'replace'`, a direct
 * edit) or straight after it (`'after'`, where a proposal offers it, so the
 * struck words read first). Returns every element written.
 *
 * ONE BULLET MAY BECOME SEVERAL. The prompt lets a `replace_block` carry
 * multi-line markdown — regrouping a topic replaces one flat bullet with a
 * lead bullet and its sub-points — so the marker stripping has to be a
 * per-line read, not a single-line regex. `LIST_LINE` has no `m` flag, so it
 * matched nothing on a multi-line string and the `- ` markers survived into
 * the item's text: an empty bullet with the whole replacement nested under
 * it, reported as `applied`.
 */
function writeReplacement(
  fragment: Y.XmlFragment,
  el: Y.XmlElement,
  markdown: string,
  mode: 'replace' | 'after',
): Y.XmlElement[] | 'unknown-block' | 'parse-failed' {
  const parent = (el.parent as Y.XmlFragment | Y.XmlElement | null) ?? fragment;
  const idx = (parent.toArray() as unknown[]).indexOf(el);
  if (idx < 0) return 'unknown-block';
  const at = mode === 'replace' ? idx : idx + 1;
  if (el.nodeName === 'listItem') {
    const split = splitLeadingListItems(markdown);
    const items = (split ? split.items : [markdown.replace(LIST_LINE, '$3')])
      .map(buildListItem)
      .filter((made): made is Y.XmlElement => made !== null);
    if (items.length === 0) return 'parse-failed';
    if (mode === 'replace') parent.delete(idx, 1);
    const created = insertParsed(parent, at, items);
    // Whatever followed the run of items is still the caller's words, and a
    // paragraph cannot live between two list items — it goes after the list.
    if (split && split.rest.trim().length > 0) {
      created.push(...insertAfterList(fragment, parent, split.rest));
    }
    return created;
  }
  const blocks = parseMarkdownBlocks(markdown);
  if (blocks.length === 0) return 'parse-failed';
  if (mode === 'replace') parent.delete(idx, 1);
  return insertParsed(parent, at, blocks);
}

const ALREADY_PROPOSED =
  'the block already carries a pending suggestion; accept or reject it first';
const TEXTLESS_BLOCK =
  'the replacement holds a block with no text (a rule or an image), which a suggestion cannot carry';

/**
 * Turn a replace or delete of a block the caller does not own into a pending
 * proposal (`suggest-blocks.ts`): the block's words struck, the replacement
 * offered as blocks beside it. Writes nothing when it cannot propose — an
 * outcome of `failed` means the doc is exactly as it was. The offered blocks
 * are the caller's, as a direct replacement would be: accepting keeps them.
 */
function proposeEdit(
  fragment: Y.XmlFragment,
  el: Y.XmlElement,
  replacement: string | null,
  opts: Pick<ApplyBlockEditsOptions, 'author' | 'suggestionAuthor'>,
): { suggestionId: string } | { error: BlockEditError; reason?: string } {
  const struck = blockText(el);
  if (struck === null) return { error: 'suggest-failed', reason: ALREADY_PROPOSED };
  if (struck.length === 0) return { error: 'no-range' };
  let offered: Y.XmlElement[] = [];
  if (replacement !== null) {
    const written = writeReplacement(fragment, el, replacement, 'after');
    if (typeof written === 'string') return { error: written };
    if (!offerWhole(written)) return { error: 'suggest-failed', reason: TEXTLESS_BLOCK };
    offered = written;
    for (const made of offered) claimSubtree(made, opts.author);
  }
  return { suggestionId: markBlockProposal(struck, offered, opts.suggestionAuthor) };
}

/** The end of a heading's section: the index of the next heading at the same
 *  level or higher, or the end of the fragment. */
function sectionEndIndex(fragment: Y.XmlFragment, heading: Y.XmlElement): number {
  const tops = fragment.toArray() as (Y.XmlElement | Y.XmlText)[];
  const start = tops.indexOf(heading);
  if (start < 0) return tops.length;
  const level = headingLevelOf(heading);
  for (let i = start + 1; i < tops.length; i++) {
    const el = tops[i];
    if (el instanceof Y.XmlElement && el.nodeName === 'heading' && headingLevelOf(el) <= level) {
      return i;
    }
  }
  return tops.length;
}

/** Remove `el` from whatever holds it. */
function deleteElement(fragment: Y.XmlFragment, el: Y.XmlElement): boolean {
  const parent = (el.parent as Y.XmlFragment | Y.XmlElement | null) ?? fragment;
  const idx = (parent.toArray() as unknown[]).indexOf(el);
  if (idx < 0) return false;
  parent.delete(idx, 1);
  // A list emptied by that delete is furniture nobody asked for.
  if (parent instanceof Y.XmlElement && isList(parent) && parent.length === 0) {
    deleteElement(fragment, parent);
  }
  return true;
}

/**
 * Apply a batch of block-addressed edits in one transaction.
 *
 * Edits are applied in order, and each is resolved against the doc as the
 * ones before it left it — so a batch may insert a heading and then insert
 * under it. Nothing throws: an edit naming a block that is gone reports
 * `unknown-block` and the rest of the batch still lands.
 */
export function applyBlockEdits(
  doc: Y.Doc,
  edits: readonly BlockEdit[],
  opts: ApplyBlockEditsOptions,
): ApplyBlockEditsResult {
  const outcomes: BlockEditOutcome[] = [];
  const fragment = getProseFragment(doc);

  doc.transact(() => {
    for (const edit of edits) {
      switch (edit.op) {
        case 'insert_at_end':
        case 'insert_under_heading': {
          if (edit.markdown.trim().length === 0) {
            outcomes.push({ op: edit.op, status: 'failed', error: 'empty' });
            break;
          }
          let at = fragment.length;
          if (edit.op === 'insert_under_heading') {
            const heading = findBlockById(fragment, edit.headingId);
            if (!heading) {
              outcomes.push({ op: edit.op, status: 'failed', error: 'unknown-block' });
              break;
            }
            if (heading.nodeName !== 'heading') {
              outcomes.push({ op: edit.op, status: 'failed', error: 'not-a-heading' });
              break;
            }
            at = sectionEndIndex(fragment, heading);
          }
          const created = insertBlocksMerging(fragment, at, edit.markdown);
          if (created.length === 0) {
            outcomes.push({ op: edit.op, status: 'failed', error: 'parse-failed' });
            break;
          }
          for (const el of created) claimSubtree(el, opts.author);
          outcomes.push({ op: edit.op, status: 'applied' });
          break;
        }
        case 'nest_blocks': {
          outcomes.push(nestBlocksOutcome(fragment, edit, opts.author));
          break;
        }
        case 'replace_block':
        case 'delete_block': {
          const el = findBlockById(fragment, edit.blockId);
          if (!el) {
            outcomes.push({ op: edit.op, status: 'failed', error: 'unknown-block' });
            break;
          }
          const replacement = edit.op === 'replace_block' ? edit.markdown : null;
          // Emptying a block is `delete_block`, said out loud — for a proposal
          // as much as a direct edit. A model returning "" must not become a
          // redline striking a person's paragraph.
          if (replacement !== null && replacement.trim().length === 0) {
            outcomes.push({ op: edit.op, status: 'failed', error: 'empty' });
            break;
          }
          if (readBlockAuthor(el) !== opts.author) {
            // Not ours (or no longer ours): propose it, in this transaction,
            // so a reader sees the batch land whole or not at all.
            const res = proposeEdit(fragment, el, replacement, opts);
            outcomes.push(
              'suggestionId' in res
                ? { op: edit.op, status: 'suggested', suggestionId: res.suggestionId }
                : { op: edit.op, status: 'failed', error: res.error, reason: res.reason },
            );
            break;
          }
          if (replacement === null) {
            const gone = deleteElement(fragment, el);
            outcomes.push(
              gone
                ? { op: edit.op, status: 'applied' }
                : { op: edit.op, status: 'failed', error: 'unknown-block' },
            );
            break;
          }
          const written = writeReplacement(fragment, el, replacement, 'replace');
          if (typeof written === 'string') {
            outcomes.push({ op: edit.op, status: 'failed', error: written });
            break;
          }
          for (const made of written) claimSubtree(made, opts.author);
          outcomes.push({ op: edit.op, status: 'applied' });
          break;
        }
      }
    }
    // Ids for everything just written, inside the same transaction: a reader
    // watching the doc must never see a block that has no address yet.
    mintMissingIds(fragment);
  }, opts.transactionOrigin ?? 'agent');

  return {
    applied: outcomes.filter((o) => o.status === 'applied').length,
    suggested: outcomes.filter((o) => o.status === 'suggested').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    outcomes,
  };
}

/** Every block a given author still holds. The set an agent may edit
 *  directly, and the scope an in-place rewrite must stay inside. */
export function blocksAuthoredBy(doc: Y.Doc, author: string): Y.XmlElement[] {
  return addressableBlocks(getProseFragment(doc)).filter((el) => readBlockAuthor(el) === author);
}

/** Drop an author's claim on every block it holds. Used when a session ends
 *  and the agent should stop treating a doc's words as its own to rewrite. */
export function releaseAuthorship(doc: Y.Doc, author: string, origin: unknown = 'agent'): number {
  const held = blocksAuthoredBy(doc, author);
  if (held.length === 0) return 0;
  doc.transact(() => {
    for (const el of held) el.removeAttribute(BLOCK_AUTHOR_ATTR);
  }, origin);
  return held.length;
}
