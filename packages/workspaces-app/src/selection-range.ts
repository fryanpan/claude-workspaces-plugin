import type { EditorView } from '@tiptap/pm/view';

/**
 * Where a reader's DOM selection sits in the doc, for a comment to anchor to.
 *
 * Two cases ProseMirror's own selection does not cover:
 *
 * - **View mode.** With the editor not editable, a long-press selection —
 *   notably on iOS Safari — never reaches ProseMirror's selection, so it reads
 *   empty while the reader has visibly selected text. The DOM range is mapped
 *   back to doc positions with `posAtDOM`.
 * - **Text a component drew.** A live component (`mdx-component.ts`) draws
 *   into the page, outside the doc's text: its words have no doc position. A
 *   selection inside one anchors to the component tag's source instead — the
 *   `mdx-flow` block's text, which is in the doc — and carries the words the
 *   reader selected as the comment's snippet. The source opens when the block
 *   holds an open comment (`mdx-flow-block.ts`), so the comment can be seen.
 *   This is what makes a component's text commentable without a frame bridge.
 */
export interface DomSelectionRange {
  from: number;
  to: number;
  /** The words to quote, when they differ from the doc text at from..to. */
  snippet?: string;
}

/** A selection is in a component's drawing when both ends sit in one. */
const COMPONENT_HOST = '.mdx-live';
const BLOCK = '.mdx-block';

function closestEl(node: Node, selector: string): Element | null {
  const el = node instanceof Element ? node : node.parentElement;
  return el?.closest(selector) ?? null;
}

/** The selection's range when it is non-empty and inside the editor. */
function rangeIn(view: EditorView, sel: Selection | null): Range | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!view.dom.contains(range.startContainer) || !view.dom.contains(range.endContainer)) {
    return null;
  }
  return range;
}

/**
 * The source of the component tag `sel` lies inside, with the selected words
 * as the snippet; null when the selection is not wholly inside one component.
 */
export function componentSelectionRange(
  view: EditorView,
  sel: Selection | null,
): DomSelectionRange | null {
  const range = rangeIn(view, sel);
  if (!range) return null;
  const host = closestEl(range.startContainer, COMPONENT_HOST);
  if (!host || host !== closestEl(range.endContainer, COMPONENT_HOST)) return null;
  const block = host.closest(BLOCK);
  const words = range.toString().replace(/\s+/g, ' ').trim();
  if (!block || !words) return null;
  const found: DomSelectionRange[] = [];
  view.state.doc.descendants((node, pos) => {
    if (found.length > 0) return false;
    if (view.nodeDOM(pos) !== block) return true;
    // The block's text runs from just inside its opening to just inside its close.
    if (node.content.size > 0) found.push({ from: pos + 1, to: pos + node.nodeSize - 1 });
    return false;
  });
  const at = found[0];
  return at ? { ...at, snippet: words.slice(0, 80) } : null;
}

/** The doc positions of a DOM selection made where ProseMirror did not see it. */
export function domSelectionRange(
  view: EditorView,
  sel: Selection | null,
): DomSelectionRange | null {
  const range = rangeIn(view, sel);
  if (!range) return null;
  let a: number;
  let b: number;
  try {
    a = view.posAtDOM(range.startContainer, range.startOffset);
    b = view.posAtDOM(range.endContainer, range.endOffset);
  } catch {
    return null;
  }
  if (a < 0 || b < 0 || a === b) return null;
  return { from: Math.min(a, b), to: Math.max(a, b) };
}
