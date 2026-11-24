/**
 * Which blocks are addressable, and the id each one answers to.
 *
 * Split from `prose-outline.ts`, which reads these addresses into an outline
 * and re-exports everything here. The reason for the split is the rule this
 * file holds: computing an address WRITES NOTHING. A block with no stored
 * `cwId` answers to `derivedBlockId` (its Yjs item id), and only a write's
 * transaction stores it (`storeBlockAddresses`), as that same value. So an
 * outline read is a pure read, and an id it handed out still names its block
 * after the next edit stores it.
 */
import * as Y from 'yjs';
import { getProseFragment } from './prose-fragment.ts';
import { BLOCK_AUTHOR_ATTR, BLOCK_ID_ATTR, derivedBlockId, readBlockId } from './prose-identity.ts';

/** Node names an id is minted for. A list is addressed through its ITEMS —
 *  "replace that bullet" is the edit people actually ask for — so the list
 *  container gets an id too but is rarely named. Table internals do not:
 *  nothing addresses a table cell by id, and minting there would be churn. */
const ADDRESSABLE = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'bulletList',
  'orderedList',
  'listItem',
  'horizontalRule',
  'image',
  'table',
]);

/** Is this element one an id is minted for? */
export function isAddressable(el: Y.XmlElement): boolean {
  return ADDRESSABLE.has(el.nodeName);
}

export function isListEl(el: Y.XmlElement): boolean {
  return el.nodeName === 'bulletList' || el.nodeName === 'orderedList';
}

/**
 * Every addressable element in the fragment, in document order.
 *
 * The walk stops at three places on purpose. A list ITEM's paragraph is the
 * item's own words, not a block beside it — addressing both would offer an
 * agent two names for one bullet and print every bullet twice in an outline
 * — so an item is descended into only for the lists nested under it. A
 * table is one block: nothing addresses a cell, and minting inside one is
 * churn on every read.
 *
 * A BLOCK QUOTE'S PARAGRAPHS ARE THE QUOTE'S OWN WORDS, for the same reason
 * and with a worse failure when it was not so. `> some quote` parses to
 * `blockquote > paragraph`, so one inserted quote printed TWO outline entries
 * carrying the same text, with nothing saying one held the other. An agent
 * that read that as a duplicate and deleted "the paragraph" emptied the quote
 * — the words gone from the doc and from the file, a `>` left behind, and the
 * lead-in sentence ending in a colon left with nothing after it. Reported
 * twice in one day. So a quote is one address: its direct paragraph children
 * are skipped, and the entry an outline hands out is the blockquote's.
 *
 * A quote is descended into for everything ELSE it holds — a list, a nested
 * quote, a code block — because those are structures an agent addresses in
 * their own right, exactly as a list item is descended into for its lists. The
 * consequence, stated where the choice is made: a multi-paragraph quote (the
 * shape the browser editor builds when a person presses Enter inside one) is
 * editable AS A WHOLE and not paragraph by paragraph. `replace_block` on the
 * quote's id, with `> a\n>\n> b` for markdown, is how a paragraph inside one
 * gets rewritten.
 */
export function addressableBlocks(fragment: Y.XmlFragment): Y.XmlElement[] {
  const out: Y.XmlElement[] = [];
  const visit = (node: Y.XmlElement | Y.XmlText | Y.XmlHook): void => {
    if (!(node instanceof Y.XmlElement)) return;
    if (isAddressable(node)) out.push(node);
    if (node.nodeName === 'table') return;
    for (const child of node.toArray()) {
      if (node.nodeName === 'listItem' && !(child instanceof Y.XmlElement && isListEl(child))) {
        continue;
      }
      if (
        node.nodeName === 'blockquote' &&
        child instanceof Y.XmlElement &&
        child.nodeName === 'paragraph'
      ) {
        continue;
      }
      visit(child as Y.XmlElement | Y.XmlText);
    }
  };
  for (const child of fragment.toArray()) visit(child as Y.XmlElement | Y.XmlText);
  return out;
}

/**
 * Every addressable block with the id it answers to, in document order,
 * computed without writing.
 *
 * A stored id belongs to ONE holder. An id is an address, and an address
 * naming two blocks sends an edit to whichever a lookup meets first; the
 * browser no longer makes copies (`block-identity.ts`), but a doc may still
 * hold them. The holder whose derived id IS the stored value keeps it (that
 * value was stored for that element), else the first in document order.
 * Every other holder, and every block with no id, answers to its derived id.
 */
export function blockAddresses(fragment: Y.XmlFragment): { el: Y.XmlElement; id: string }[] {
  const blocks = addressableBlocks(fragment);
  const owner = new Map<string, Y.XmlElement>();
  for (const el of blocks) {
    const id = readBlockId(el);
    if (id === undefined) continue;
    if (!owner.has(id) || derivedBlockId(el) === id) owner.set(id, el);
  }
  const used = new Set(owner.keys());
  const out: { el: Y.XmlElement; id: string }[] = [];
  for (const el of blocks) {
    const stored = readBlockId(el);
    if (stored !== undefined && owner.get(stored) === el) {
      out.push({ el, id: stored });
      continue;
    }
    let id = derivedBlockId(el);
    if (id === undefined) continue;
    while (used.has(id)) id = `${id}_`;
    used.add(id);
    out.push({ el, id });
  }
  return out;
}

/** The blocks whose stored id is a COPY of another holder's. */
export function duplicateIdBlocks(fragment: Y.XmlFragment): Y.XmlElement[] {
  return blockAddresses(fragment)
    .filter(({ el, id }) => readBlockId(el) !== undefined && readBlockId(el) !== id)
    .map(({ el }) => el);
}

/**
 * Store every block's address as its `cwId`: an id for each block that has
 * none, and one of its own for each copy, which also drops the author it
 * copied (nothing proves the agent wrote a block that only carries another
 * block's attributes). The stored value is the address `blockAddresses`
 * already reported, so an id an outline handed out still names its block.
 * Call inside a WRITE's transaction, never a read's. Returns how many it set.
 */
export function storeBlockAddresses(fragment: Y.XmlFragment): number {
  let set = 0;
  for (const { el, id } of blockAddresses(fragment)) {
    const stored = readBlockId(el);
    if (stored === id) continue;
    el.setAttribute(BLOCK_ID_ATTR, id);
    if (stored !== undefined) el.removeAttribute(BLOCK_AUTHOR_ATTR);
    set++;
  }
  return set;
}

/** `storeBlockAddresses` for the copies only. Call inside a transaction. */
export function remintDuplicateIds(fragment: Y.XmlFragment): number {
  const ids = new Map(blockAddresses(fragment).map(({ el, id }) => [el, id]));
  const copies = duplicateIdBlocks(fragment);
  for (const el of copies) {
    el.setAttribute(BLOCK_ID_ATTR, ids.get(el) as string);
    el.removeAttribute(BLOCK_AUTHOR_ATTR);
  }
  return copies.length;
}

/**
 * `storeBlockAddresses` in a transaction of its own, and no transaction at
 * all when there is nothing to store. A write, so no read path calls it.
 * Returns how many ids were stored.
 */
export function ensureBlockIds(doc: Y.Doc, opts: { transactionOrigin?: unknown } = {}): number {
  const fragment = getProseFragment(doc);
  const pending = blockAddresses(fragment).filter(({ el, id }) => readBlockId(el) !== id);
  if (pending.length === 0) return 0;
  let set = 0;
  doc.transact(() => {
    set = storeBlockAddresses(fragment);
  }, opts.transactionOrigin ?? 'block-ids');
  return set;
}

/** The element answering to `id`, stored or derived, or nothing. */
export function findBlockById(fragment: Y.XmlFragment, id: string): Y.XmlElement | undefined {
  return blockAddresses(fragment).find((b) => b.id === id)?.el;
}
