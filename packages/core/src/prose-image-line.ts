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
import { findFootnotes, footnoteEndAt } from './footnotes.ts';
import { resolveRelativePositionRaw } from './prose-fragment.ts';
import { BLOCK_IDENTITY_ATTRS } from './prose-identity.ts';

/**
 * The parts of an image line. After the closing paren a line may carry a
 * display width, `{width=480}` (pandoc's attribute syntax, whole pixels
 * only), and then one or more `^[…]` footnotes. Both are written in exactly
 * one spelling, so the line the serializer writes back is the line it read.
 */
interface ImageLine {
  src: string;
  alt: string;
  title?: string;
  width?: number;
  footnotes?: string;
}

const IMAGE_HEAD = /^!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)(?:\{width=([1-9]\d{0,4})\})?/;

/** Whether `rest` is nothing but `^[…]` notes, back to back. */
function isFootnoteRun(rest: string): boolean {
  if (rest.length === 0) return false;
  let i = 0;
  while (i < rest.length) {
    const end = footnoteEndAt(rest, i);
    if (end < 0) return false;
    i = end;
  }
  return true;
}

function readImageLine(s: string): ImageLine | null {
  const line = s.trim();
  if (!/^!\[[^\]]*\]\([^)]*\)/.test(line)) return null;
  const m = line.match(IMAGE_HEAD);
  if (!m) return null;
  const rest = line.slice(m[0].length);
  if (rest.length > 0 && !isFootnoteRun(rest)) return null;
  return {
    src: m[2] ?? '',
    alt: m[1] ?? '',
    ...(m[3] ? { title: m[3] } : {}),
    ...(m[4] ? { width: Number(m[4]) } : {}),
    ...(rest ? { footnotes: rest } : {}),
  };
}

/** A line that is only a markdown image: `![alt](src)` or `![alt](src "title")`,
 *  optionally followed by `{width=N}` and then `^[…]` footnotes. */
export function isImageLine(s: string): boolean {
  return readImageLine(s) !== null;
}

/**
 * Build an `image` node from a standalone image line. The node name matches
 * the Tiptap Image extension so it renders in the live editor; src, alt,
 * title and width round-trip as attributes, and trailing footnotes as the
 * raw `^[…]` text in `footnotes`. src is matched as a run of non-space
 * characters, so remote URLs and relative paths both work and underscores in
 * the path are never parsed as emphasis.
 */
export function imageFromLine(raw: string): Y.XmlElement {
  const parts = readImageLine(raw);
  const img = new Y.XmlElement('image');
  img.setAttribute('src', parts?.src ?? '');
  img.setAttribute('alt', parts?.alt ?? '');
  if (parts?.title) img.setAttribute('title', parts.title);
  if (parts?.width) img.setAttribute('width', parts.width as unknown as string);
  if (parts?.footnotes) img.setAttribute('footnotes', parts.footnotes);
  return img;
}

/** A display width as the line writes it, or null for none. The editor may
 *  hand back a number or a numeric string; anything else is no width. */
export function imageWidthOf(value: unknown): number | null {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(n) && n > 0 && n < 100_000 ? n : null;
}

/** The note bodies an image's `footnotes` attribute holds, in order — what
 *  the editor and the first paint draw as the caption under the picture. */
export function imageNotesOf(footnotes: unknown): string[] {
  return typeof footnotes === 'string' ? findFootnotes(footnotes).map((f) => f.note) : [];
}

/** The markdown line an `image` node serializes to, or null when it has no src. */
export function imageLineOf(node: Y.XmlElement): string | null {
  const src = String(node.getAttribute('src') ?? '');
  if (!src) return null;
  const alt = String(node.getAttribute('alt') ?? '');
  const title = node.getAttribute('title');
  const titlePart = title ? ` "${String(title)}"` : '';
  const width = imageWidthOf(node.getAttribute('width'));
  const widthPart = width === null ? '' : `{width=${width}}`;
  const notes = node.getAttribute('footnotes');
  const notesPart = typeof notes === 'string' && isFootnoteRun(notes) ? notes : '';
  return `![${alt}](${src}${titlePart})${widthPart}${notesPart}`;
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
