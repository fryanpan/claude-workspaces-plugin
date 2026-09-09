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

/** Read a block's author, or nothing if no agent claims it. */
export function readBlockAuthor(el: Y.XmlElement): string | undefined {
  const raw = el.getAttribute(BLOCK_AUTHOR_ATTR);
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Mark a block as written by `author`. */
export function setBlockAuthor(el: Y.XmlElement, author: string): void {
  el.setAttribute(BLOCK_AUTHOR_ATTR, author);
}
