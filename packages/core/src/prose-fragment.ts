/**
 * The prose fragment itself: how to reach it, how to walk it, and how to
 * turn a stored anchor back into a place inside it.
 *
 * This is the leaf of the `prose.ts` family — `prose-markdown.ts`,
 * `prose-edit.ts` and `prose-blocks.ts` all build on it and none of them may
 * be imported from here. It exists because all three need the same walk and
 * the same coordinate resolvers, and leaving those in `prose.ts` (which
 * re-exports the three) would have made every one of them import the file
 * that imports it.
 *
 * The fragment is a tree of `Y.XmlElement` nodes (paragraph, heading,
 * bulletList, …) with `Y.XmlText` leaves. We never run a headless
 * prosemirror view server-side — we walk the Yjs tree directly.
 */
import * as Y from 'yjs';
import { decodeRelativePositionSafe } from './anchor/validate.ts';
import { readBlockAuthor } from './prose-identity.ts';

export const PROSE_FRAGMENT_KEY = 'prose';

export function getProseFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(PROSE_FRAGMENT_KEY);
}

/** A single source text segment + the Y.XmlText it came from. */
export interface TextSegment {
  node: Y.XmlText;
  /** Offset of this segment's start within the flattened doc text. */
  docOffset: number;
  /** Length of this segment (= node.length at walk time). */
  length: number;
  /** Innermost block the text lives inside (paragraph inside table cell, etc.). */
  block: Y.XmlElement | null;
  /** Innermost block tag name. */
  blockType: string | null;
  /** TOP-LEVEL block the text lives inside (table, heading, paragraph at doc root).
   *  Differs from `block` for nested structures — a table cell's paragraph has
   *  blockType='paragraph' but topBlockType='table'. Used by get_doc to surface
   *  structural containers (tables, lists) as one logical block instead of N. */
  topBlock: Y.XmlElement | null;
  topBlockType: string | null;
  /** If a heading, its level attribute. */
  headingLevel?: number;
}

/**
 * Walk the fragment depth-first, emitting every Y.XmlText leaf with a
 * running offset into the flattened doc text. Block nodes contribute a
 * synthetic "\n\n" separator between them so the flat text has paragraph
 * breaks — but the separator is NOT part of any node (no way to edit it
 * via find_and_replace, which is what we want).
 */
export function walkProse(fragment: Y.XmlFragment): {
  plainText: string;
  segments: TextSegment[];
} {
  const segments: TextSegment[] = [];
  let plainText = '';
  let docOffset = 0;

  const visit = (
    node: Y.XmlElement | Y.XmlText | Y.XmlFragment,
    currentBlock: Y.XmlElement | null,
    topBlock: Y.XmlElement | null,
  ): void => {
    if (node instanceof Y.XmlText) {
      const length = node.length;
      segments.push({
        node,
        docOffset,
        length,
        block: currentBlock,
        blockType: currentBlock?.nodeName ?? null,
        topBlock,
        topBlockType: topBlock?.nodeName ?? null,
        headingLevel:
          currentBlock?.nodeName === 'heading' ? headingLevelOf(currentBlock) : undefined,
      });
      // IMPORTANT: toString() includes XML wrappers around marks
      // (e.g. "<bold>hello</bold>") but node.length is the unmarked
      // character count (5). If we used toString() here, plainText
      // would grow faster than docOffset and every segment after a
      // marked span would have an incorrect offset — find_and_replace
      // would silently no-match or land edits in the wrong place.
      // toDelta() gives us the raw insert strings without the wrappers.
      for (const op of node.toDelta() as Array<{ insert?: string }>) {
        if (typeof op.insert === 'string') plainText += op.insert;
      }
      docOffset += length;
      return;
    }
    if (node instanceof Y.XmlElement) {
      // New block? Insert a paragraph break before it (but not at the start).
      if (isBlock(node.nodeName) && plainText.length > 0 && !plainText.endsWith('\n\n')) {
        plainText += '\n\n';
        docOffset += 2;
      }
      const childBlock = isBlock(node.nodeName) ? node : currentBlock;
      // topBlock sticks to the first block we entered — doesn't update for
      // nested blocks inside it (so table-cell text reports topBlock=table).
      const childTop = isBlock(node.nodeName) ? (topBlock ?? node) : topBlock;
      for (const child of node.toArray())
        visit(child as Y.XmlElement | Y.XmlText, childBlock, childTop);
      return;
    }
    // Y.XmlFragment (top-level)
    for (const child of node.toArray())
      visit(child as Y.XmlElement | Y.XmlText, currentBlock, topBlock);
  };

  visit(fragment, null, null);
  return { plainText, segments };
}

function isBlock(tag: string): boolean {
  // Any prosemirror block node that can contain text. The list here
  // matches tiptap-starter-kit's defaults plus @tiptap/extension-table.
  return (
    tag === 'paragraph' ||
    tag === 'heading' ||
    tag === 'blockquote' ||
    tag === 'codeBlock' ||
    tag === 'bulletList' ||
    tag === 'orderedList' ||
    tag === 'listItem' ||
    tag === 'horizontalRule' ||
    tag === 'table' ||
    tag === 'tableRow' ||
    tag === 'tableCell' ||
    tag === 'tableHeader'
  );
}

/**
 * `verbatim` keeps newlines as-is instead of flattening them to spaces.
 * The flattened form is for DISPLAY (ambiguous-match candidate lists); a
 * near-miss hint must quote the doc's characters byte-for-byte, because the
 * caller is told to re-issue the find from it — flattening a newline there
 * hands back the exact string that just failed, an infinite loop.
 */
export function preview(text: string, at: number, length: number, verbatim = false): string {
  const pad = 24;
  const start = Math.max(0, at - pad);
  const end = Math.min(text.length, at + length + pad);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const body = text.slice(start, end);
  return prefix + (verbatim ? body : body.replace(/\n/g, ' ')) + suffix;
}

/** Resolve a serialized Y.RelativePosition to an absolute position in
 *  the flattened prose text. Returns null if the anchor no longer
 *  references a valid point in the doc. */
export function resolveRelativePosition(doc: Y.Doc, encoded: Uint8Array): number | null {
  const abs = resolveRelativePositionRaw(doc, encoded);
  if (!abs) return null;
  const fragment = getProseFragment(doc);
  const { segments } = walkProse(fragment);
  for (const s of segments) {
    if (s.node === abs.node) return s.docOffset + abs.offset;
  }
  return null;
}

/** Same resolution, but returns the Y.XmlText + local offset so callers
 *  that need to mutate (splice, insert) can operate directly on the node.
 *
 *  An anchor whose bytes don't decode answers null, exactly like one that no
 *  longer resolves. This is the single busiest reader of a stored anchor, and
 *  most of its callers run inside a Yjs observer where a throw would land on
 *  an unrelated request. */
export function resolveRelativePositionRaw(
  doc: Y.Doc,
  encoded: Uint8Array,
): { node: Y.XmlText; offset: number } | null {
  const rel = decodeRelativePositionSafe(encoded);
  if (!rel) return null;
  const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
  if (!abs) return null;
  if (!(abs.type instanceof Y.XmlText)) return null;
  return { node: abs.type, offset: abs.index };
}

/** A heading's level, whatever form it was persisted in. */
export function headingLevelOf(el: Y.XmlElement): number {
  const raw = Number(el.getAttribute('level') ?? 1);
  return Number.isFinite(raw) ? Math.min(6, Math.max(1, raw)) : 1;
}

/**
 * A paragraph with nothing in it that nobody has claimed — which in this
 * document can only be the one a browser puts at the end.
 *
 * Tiptap's StarterKit registers `TrailingNode`, which keeps an empty
 * paragraph after the last block whenever that block is not one, so a person
 * has somewhere to click and type. Nothing else in the system mints an empty
 * unclaimed paragraph: every block this file inserts is claimed for its
 * author on the way in, and a paragraph a person actually typed into has
 * words in it.
 *
 * The two halves of the test, and what each one is worth:
 *
 * - **Empty** is read from the CRDT, not from a serialization: every child
 *   must be a `Y.XmlText` whose text is blank. An inline element — an image,
 *   a hard break — is content, and a `Y.XmlText` carrying marks serializes
 *   its wrappers, so both stop the paragraph counting as empty. The test
 *   errs towards saying "not empty", which costs a merge rather than a
 *   person's spacing.
 * - **Unclaimed** is `cwAuthor` absent. An agent's own empty paragraph is
 *   NOT stepped over: it is a block the agent may still address by id, and
 *   walking past it would let a later insert reach behind something the
 *   agent deliberately put at the section end.
 *
 * What it cannot tell apart: a paragraph a person typed into and then
 * cleared. Person edits clear authorship (`clearAuthorshipOnPersonEdit`)
 * and a person's own block never carried it, so an emptied paragraph is
 * byte-identical to the browser's. Such a paragraph used as a deliberate
 * spacer above a list would be stepped over and the new items would join
 * the list above it. Nothing is deleted or rewritten either way — the
 * paragraph stays exactly where it is — so the cost is one bullet joining
 * a list rather than opening a new one.
 */
export function isUnclaimedBlankParagraph(el: Y.XmlElement | Y.XmlText | undefined): boolean {
  if (!(el instanceof Y.XmlElement) || el.nodeName !== 'paragraph') return false;
  if (readBlockAuthor(el) !== undefined) return false;
  for (const child of el.toArray() as (Y.XmlElement | Y.XmlText)[]) {
    if (!(child instanceof Y.XmlText)) return false;
    if (child.toString().trim().length > 0) return false;
  }
  return true;
}

/**
 * The block a merge should treat as preceding `index` in `siblings`.
 *
 * That is `index - 1` unless the browser's trailing paragraphs are in the
 * way — see `isUnclaimedBlankParagraph` for why they are there and why
 * stepping over them is safe. Returns `undefined` when nothing is left.
 */
export function precedingBlock(
  siblings: readonly (Y.XmlElement | Y.XmlText)[],
  index: number,
): Y.XmlElement | Y.XmlText | undefined {
  let scan = index - 1;
  while (scan >= 0 && isUnclaimedBlankParagraph(siblings[scan])) scan--;
  return siblings[scan];
}
