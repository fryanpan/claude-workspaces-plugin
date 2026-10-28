/**
 * A batch of block-addressed edits, applied in ONE Yjs transaction.
 *
 * One verb per call is right for an agent making one change and wrong for one
 * composing a handful at once — a note-taker adding two bullets and rewriting
 * a third. Each call is its own transaction, so a reader sees the batch in
 * pieces and a failure halfway leaves half of it applied.
 *
 * So this file takes edits addressed by BLOCK ID (`prose-outline.ts`) and
 * applies them together. Two rules make the result predictable:
 *
 * - **Authorship decides direct-vs-proposal**, unless the caller asks. An
 *   edit replacing or deleting a block still marked as the caller's own
 *   applies directly; anything else — a block a person wrote, or one of the
 *   caller's a person has since touched, the same thing after
 *   `clearAuthorshipOnPersonEdit` — becomes a block proposal
 *   (`suggest-blocks.ts`): the words struck, the replacement offered beside
 *   them. `propose` on a replace takes that path whoever owns the block.
 *   Nothing here can destroy words the caller did not write.
 * - **A list is grown, never twinned.** Inserting bullets where the target
 *   already ends in a list of the same type puts the new items INTO that
 *   list. Splicing a second list in beside it made the browser's list-join
 *   plugin re-create the agent's own bullets, which the agent cannot find.
 *
 * How markdown becomes elements at a position is `prose-batch-write.ts`; this
 * file decides which edits apply, and whether directly or as a proposal.
 */
import * as Y from 'yjs';
import {
  holdsNoWords,
  isTextlessLeaf,
  restoreNestedNotes,
  takeNestedNotes,
} from './prose-batch-structure.ts';
import {
  insertBlocksMerging,
  insertParsed,
  isList,
  writeReplacement,
} from './prose-batch-write.ts';
import { getProseFragment, headingLevelOf } from './prose-fragment.ts';
import {
  BLOCK_AUTHOR_ATTR,
  BLOCK_ID_ATTR,
  readBlockAuthor,
  readBlockId,
} from './prose-identity.ts';
import { parseMarkdownBlocks } from './prose-markdown.ts';
import type { MarkdownParseOptions } from './prose-mdx.ts';
import { type NestBlocksError, nestBlocksOutcome } from './prose-nest.ts';
import { addressableBlocks, claimSubtree, findBlockById, newBlockId } from './prose-outline.ts';
import { type SplitBeforeError, splitBeforeBlock } from './prose-split.ts';
import { blockText, markBlockProposal, offerWhole } from './suggest-blocks.ts';
import type { SuggestionAuthor } from './suggest-ops.ts';

/** One edit, addressed by block id. */
export type BlockEdit =
  | { op: 'insert_under_heading'; headingId: string; markdown: string }
  | { op: 'insert_at_end'; markdown: string }
  // The only insert that lands anywhere but an END, and so the only one that
  // can put a heading ABOVE the notes it names. See `prose-split.ts` for why
  // that re-parents them without moving one of them.
  | { op: 'insert_before_block'; blockId: string; markdown: string }
  // `propose` makes a replace a proposal whoever owns the block — for an edit
  // whose cost to a reader is not what ownership measures. The heading rename
  // is the one that asked for it (`notes-heading-rename.ts`).
  | { op: 'replace_block'; blockId: string; markdown: string; propose?: boolean }
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
  | NestBlocksError
  | SplitBeforeError;

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
  /** How every edit's markdown parses: `{ mdx: true }` for an `.mdx` doc. */
  parse?: MarkdownParseOptions;
  /** Structure only — `NestBlocksOptions.moveOthers` is why, and who passes it. */
  moveOthers?: boolean;
}

/** Give an id to anything in `fragment` that has none. Called from INSIDE
 *  the batch transaction, which is why it is not `ensureBlockIds`. */
function mintMissingIds(fragment: Y.XmlFragment): void {
  for (const el of addressableBlocks(fragment)) {
    if (readBlockId(el) === undefined) el.setAttribute(BLOCK_ID_ATTR, newBlockId());
  }
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
  opts: Pick<ApplyBlockEditsOptions, 'author' | 'suggestionAuthor' | 'parse'>,
): { suggestionId: string } | { error: BlockEditError; reason?: string } {
  const struck = blockText(el);
  if (struck === null) return { error: 'suggest-failed', reason: ALREADY_PROPOSED };
  if (struck.length === 0) return { error: 'no-range' };
  let offered: Y.XmlElement[] = [];
  if (replacement !== null) {
    const written = writeReplacement(fragment, el, replacement, 'after', opts.parse);
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
          const created = insertBlocksMerging(fragment, at, edit.markdown, opts.parse);
          if (created.length === 0) {
            outcomes.push({ op: edit.op, status: 'failed', error: 'parse-failed' });
            break;
          }
          for (const el of created) claimSubtree(el, opts.author);
          outcomes.push({ op: edit.op, status: 'applied' });
          break;
        }
        case 'insert_before_block': {
          if (edit.markdown.trim().length === 0) {
            outcomes.push({ op: edit.op, status: 'failed', error: 'empty' });
            break;
          }
          const target = findBlockById(fragment, edit.blockId);
          if (!target) {
            outcomes.push({ op: edit.op, status: 'failed', error: 'unknown-block' });
            break;
          }
          const slot = splitBeforeBlock(fragment, target, opts.author, opts.moveOthers === true);
          if (slot.index === undefined) {
            outcomes.push({ op: edit.op, status: 'failed', error: slot.error ?? 'unknown-block' });
            break;
          }
          // NOT `insertBlocksMerging`: a slot opened in the middle of a run
          // has a list of ours on BOTH sides, and merging would grow the one
          // above rather than write between them — which is the end-placement
          // this op exists to escape, arrived at by a second route.
          const blocks = parseMarkdownBlocks(edit.markdown, opts.parse);
          if (blocks.length === 0) {
            outcomes.push({ op: edit.op, status: 'failed', error: 'parse-failed' });
            break;
          }
          for (const el of insertParsed(fragment, slot.index, blocks))
            claimSubtree(el, opts.author);
          outcomes.push({ op: edit.op, status: 'applied' });
          break;
        }
        case 'nest_blocks': {
          outcomes.push(nestBlocksOutcome(fragment, edit, opts.author, opts.moveOthers === true));
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
          // A block with no words has nothing to protect and nothing a
          // proposal could strike, so it applies directly whoever owns it.
          // So does an image or a rule, unless a proposal was asked for.
          const asked = edit.op === 'replace_block' && edit.propose === true;
          const direct = holdsNoWords(el) || (isTextlessLeaf(el) && !asked);
          if ((asked || readBlockAuthor(el) !== opts.author) && !direct) {
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
          const nested = takeNestedNotes(el);
          const written = writeReplacement(fragment, el, replacement, 'replace', opts.parse);
          if (typeof written === 'string') {
            outcomes.push({ op: edit.op, status: 'failed', error: written });
            break;
          }
          for (const made of written) claimSubtree(made, opts.author);
          restoreNestedNotes(fragment, written, nested);
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

/** Drop an author's claim on every block it holds, except the ids in `keep`.
 *  Used when a session ends and the agent should stop treating a doc's words
 *  as its own to rewrite. */
export function releaseAuthorship(
  doc: Y.Doc,
  author: string,
  origin: unknown = 'agent',
  keep: ReadonlySet<string> = new Set(),
): number {
  const held = blocksAuthoredBy(doc, author).filter((el) => {
    const id = readBlockId(el);
    return id === undefined || !keep.has(id);
  });
  if (held.length === 0) return 0;
  doc.transact(() => {
    for (const el of held) el.removeAttribute(BLOCK_AUTHOR_ATTR);
  }, origin);
  return held.length;
}
