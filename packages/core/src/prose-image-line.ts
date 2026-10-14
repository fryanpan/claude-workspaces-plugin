/**
 * A standalone `![alt](src)` line, and turning a paragraph that holds one as
 * text into the `image` node the parser would have made.
 *
 * The parser reads such a line as an image node. An edit that writes the same
 * characters into an existing paragraph — a find-and-replace, a thread-region
 * rewrite, an insert after a thread — leaves them as paragraph TEXT, and the
 * editor shows the markdown instead of the picture. Nothing repaired it later:
 * a paragraph holding that text serializes to the same `.md` line as the
 * image node, so the file reconcile and a reparse both see the doc and the
 * file as in sync.
 *
 * So the paragraph is promoted in the doc, block by block. Only a paragraph
 * whose whole content is one unmarked run of exactly that line qualifies, and
 * the image keeps the paragraph's block id and author. The `.md` it
 * serializes to does not change by a byte.
 *
 * A paragraph that an OPEN comment thread is anchored in is left as text. An
 * image holds no characters, so the thread would have nothing to point at;
 * the person's question stays where they put it, and the paragraph is
 * promoted on the first load after that thread is resolved. A resolved
 * thread does not hold a paragraph back: its comments are kept, and its
 * anchor stops resolving, as it does for any block that is replaced.
 */
import * as Y from 'yjs';
import { resolveRelativePositionRaw } from './prose-fragment.ts';
import { BLOCK_IDENTITY_ATTRS } from './prose-identity.ts';

/** A line that is only a markdown image: `![alt](src)` or `![alt](src "title")`. */
export function isImageLine(s: string): boolean {
  return /^!\[[^\]]*\]\([^)]*\)\s*$/.test(s.trim());
}

/**
 * Build an `image` node from a standalone image line. The node name matches
 * the Tiptap Image extension so it renders in the live editor; src, alt and
 * title round-trip as attributes. src is matched as a run of non-space
 * characters, so remote URLs and relative paths both work and underscores in
 * the path are never parsed as emphasis.
 */
export function imageFromLine(raw: string): Y.XmlElement {
  const m = raw.trim().match(/^!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)$/);
  const img = new Y.XmlElement('image');
  img.setAttribute('src', m?.[2] ?? '');
  img.setAttribute('alt', m?.[1] ?? '');
  if (m?.[3]) img.setAttribute('title', m[3]);
  return img;
}

/** The image line a paragraph holds as its whole, unmarked text, or null. */
function imageLineHeldBy(el: Y.XmlElement): string | null {
  if (el.nodeName !== 'paragraph') return null;
  const kids = el.toArray();
  if (kids.length !== 1 || !(kids[0] instanceof Y.XmlText)) return null;
  const ops = kids[0].toDelta() as { insert?: unknown; attributes?: Record<string, unknown> }[];
  if (ops.length !== 1) return null;
  const op = ops[0]!;
  if (typeof op.insert !== 'string' || (op.attributes && Object.keys(op.attributes).length > 0)) {
    return null;
  }
  return isImageLine(op.insert) ? op.insert : null;
}

/** Every text node an open text-range thread starts or ends in. */
function textsHoldingOpenThreads(doc: Y.Doc): Set<Y.XmlText> {
  const held = new Set<Y.XmlText>();
  const threads = doc.getMap('threads') as Y.Map<Y.Map<unknown>>;
  threads.forEach((thread) => {
    if (thread.get('status') === 'resolved') return;
    const anchor = thread.get('anchor') as
      | { kind?: string; startRel?: Uint8Array; endRel?: Uint8Array }
      | undefined;
    if (anchor?.kind !== 'text-range') return;
    for (const rel of [anchor.startRel, anchor.endRel]) {
      const at = rel ? resolveRelativePositionRaw(doc, rel) : null;
      if (at) held.add(at.node);
    }
  });
  return held;
}

/** Replace the paragraph at `index` of `parent` with the image its line makes. */
function promoteAt(parent: Y.XmlFragment, index: number, el: Y.XmlElement, line: string): void {
  const img = imageFromLine(line);
  for (const name of BLOCK_IDENTITY_ATTRS) {
    const value = el.getAttribute(name);
    if (typeof value === 'string') img.setAttribute(name, value);
  }
  parent.delete(index, 1);
  parent.insert(index, [img]);
}

/**
 * Promote every top-level paragraph of `fragment` that holds a standalone
 * image line as text. Call inside a transaction. Returns how many it promoted.
 */
export function promoteImageParagraphs(doc: Y.Doc, fragment: Y.XmlFragment): number {
  const kids = fragment.toArray();
  let held: Set<Y.XmlText> | null = null;
  let promoted = 0;
  // From the end, so each replacement leaves the indexes before it valid.
  for (let i = kids.length - 1; i >= 0; i--) {
    const el = kids[i];
    if (!(el instanceof Y.XmlElement)) continue;
    const line = imageLineHeldBy(el);
    if (line === null) continue;
    held ??= textsHoldingOpenThreads(doc);
    if (held.has(el.toArray()[0] as Y.XmlText)) continue;
    promoteAt(fragment, i, el, line);
    promoted++;
  }
  return promoted;
}

/**
 * Promote the paragraph `text` sits in, when an edit has just left its whole
 * content a standalone image line. The text-editing verbs call this inside
 * their own transaction, after the write. Returns whether it promoted.
 */
export function promoteImageParagraphOf(doc: Y.Doc, text: Y.XmlText): boolean {
  const el = text.parent;
  if (!(el instanceof Y.XmlElement)) return false;
  const parent = el.parent;
  if (!(parent instanceof Y.XmlFragment) || parent instanceof Y.XmlElement) return false;
  const line = imageLineHeldBy(el);
  if (line === null || textsHoldingOpenThreads(doc).has(text)) return false;
  const index = parent.toArray().indexOf(el);
  if (index < 0) return false;
  promoteAt(parent, index, el, line);
  return true;
}
