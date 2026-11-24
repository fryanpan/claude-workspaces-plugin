/**
 * The two attributes a block carries about itself, and nothing else.
 *
 * A leaf of the prose family — it imports only Yjs — because both ends of
 * the family need it: `prose-outline.ts` reads and writes these attributes,
 * and `prose-markdown.ts` has to EXCLUDE them from the key it diffs blocks
 * by. Putting them anywhere else makes those two import each other.
 *
 * Why the attributes exist at all, and what clears them, is the header of
 * `prose-outline.ts`.
 */
import type * as Y from 'yjs';

/** Attribute holding a block's stable id. */
export const BLOCK_ID_ATTR = 'cwId';

/** Attribute holding the id of the agent that wrote a block. */
export const BLOCK_AUTHOR_ATTR = 'cwAuthor';

/** Both identity attributes, for callers that must ignore them wholesale. */
export const BLOCK_IDENTITY_ATTRS: readonly string[] = [BLOCK_ID_ATTR, BLOCK_AUTHOR_ATTR];

/** Read a block's id, or nothing if it has never been given one. */
export function readBlockId(el: Y.XmlElement): string | undefined {
  const raw = el.getAttribute(BLOCK_ID_ATTR);
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * The id a block is addressed by before it carries one: its Yjs item id,
 * which is fixed for the element's life, survives the `.ydoc` round trip and
 * is unique per doc. Reading it writes nothing, which is what lets an outline
 * read be a pure read; the first edit that writes the doc stores this same
 * value as the block's `cwId`, so an address handed out before the write
 * still names the block after it. Nothing for an element not yet in a doc.
 */
export function derivedBlockId(el: Y.XmlElement): string | undefined {
  const item = el._item;
  if (item === null) return undefined;
  return `y${item.id.client.toString(36)}-${item.id.clock.toString(36)}`;
}

/** The address a block answers to: its stored id, else its derived one. */
export function blockAddressOf(el: Y.XmlElement): string | undefined {
  return readBlockId(el) ?? derivedBlockId(el);
}

/** Read a block's author, or nothing if no agent claims it. */
export function readBlockAuthor(el: Y.XmlElement): string | undefined {
  const raw = el.getAttribute(BLOCK_AUTHOR_ATTR);
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Mark a block as written by `author`. */
export function setBlockAuthor(el: Y.XmlElement, author: string): void {
  el.setAttribute(BLOCK_AUTHOR_ATTR, author);
}
