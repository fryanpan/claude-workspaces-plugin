/**
 * The doc's text on screen before the editor has loaded.
 *
 * The editor chunk — ProseMirror, Tiptap, the review chrome, the meeting
 * surface — is most of the doc page's bytes, and a reader on a phone waited
 * for all of it before seeing a word. This draws the synced prose fragment as
 * plain read-only DOM, with the tags and classes Tiptap would give it, so the
 * page's own stylesheet lays it out the way the editor will.
 *
 * The root carries the `ProseMirror` class for that stylesheet, and the
 * editor takes the root over in place (`createEditor` mounts on it), so the
 * reader's scroll position and the element a test holds both survive the
 * hand-over. Until then the drawing follows the fragment, so an edit made
 * elsewhere still shows while the editor loads.
 *
 * Only what reading needs is drawn: blocks, text, the common marks, links and
 * images. A diagram, chart or equation shows its source until the editor
 * renders it.
 */
import { getProseFragment } from '@claude-workspaces/core/prose';
import * as Y from 'yjs';
import { docAssetsBase, toDisplaySrc } from '../doc-image-path.ts';
import { paintedLinkHref } from '../link-open.ts';
import type { MountScope } from '../mount-scope.ts';

/** Marks the root while it is still the paint; the editor removes it. */
export const FIRST_PAINT_CLASS = 'doc-first-paint';

const BLOCK_TAGS: Record<string, string> = {
  paragraph: 'p',
  blockquote: 'blockquote',
  bulletList: 'ul',
  orderedList: 'ol',
  listItem: 'li',
  taskList: 'ul',
  taskItem: 'li',
  horizontalRule: 'hr',
  hardBreak: 'br',
  tableRow: 'tr',
  tableCell: 'td',
  tableHeader: 'th',
};

const MARK_TAGS: Record<string, string> = {
  bold: 'strong',
  italic: 'em',
  strike: 's',
  code: 'code',
  underline: 'u',
};

type Attrs = Record<string, unknown>;

function renderText(text: Y.XmlText, doc: Document): DocumentFragment {
  const out = doc.createDocumentFragment();
  for (const op of text.toDelta() as { insert: unknown; attributes?: Attrs }[]) {
    if (typeof op.insert !== 'string') continue;
    let node: Node = doc.createTextNode(op.insert);
    for (const [mark, value] of Object.entries(op.attributes ?? {})) {
      const tag = MARK_TAGS[mark];
      let wrap: HTMLElement | null = tag ? doc.createElement(tag) : null;
      if (mark === 'link') {
        const href = paintedLinkHref((value as Attrs | null)?.href as string | undefined);
        wrap = doc.createElement(href ? 'a' : 'span');
        if (href) {
          wrap.setAttribute('href', href);
          wrap.setAttribute('target', '_blank');
          wrap.setAttribute('rel', 'noopener noreferrer');
        }
      }
      if (!wrap) continue;
      wrap.append(node);
      node = wrap;
    }
    out.append(node);
  }
  return out;
}

function renderElement(node: Y.XmlElement, doc: Document, imageBase: string): HTMLElement {
  const name = node.nodeName;
  const attrs = node.getAttributes() as Attrs;
  if (name === 'image') {
    const img = doc.createElement('img');
    if (typeof attrs.src === 'string') img.src = toDisplaySrc(attrs.src, imageBase);
    if (typeof attrs.alt === 'string') img.alt = attrs.alt;
    return img;
  }
  let el: HTMLElement;
  let inner: HTMLElement;
  if (name === 'heading') {
    el = doc.createElement(`h${Math.min(6, Math.max(1, Number(attrs.level) || 1))}`);
    inner = el;
  } else if (name === 'codeBlock') {
    el = doc.createElement('pre');
    inner = doc.createElement('code');
    if (typeof attrs.language === 'string' && attrs.language) {
      inner.className = `language-${attrs.language}`;
    }
    el.append(inner);
  } else if (name === 'table') {
    el = doc.createElement('table');
    el.className = 'prose-table';
    inner = doc.createElement('tbody');
    el.append(inner);
  } else {
    el = doc.createElement(BLOCK_TAGS[name] ?? 'div');
    inner = el;
    const start = Number(attrs.start);
    if (name === 'orderedList' && start > 1) el.setAttribute('start', String(start));
    for (const span of ['colspan', 'rowspan']) {
      const n = Number(attrs[span]);
      if (n > 1) el.setAttribute(span, String(n));
    }
  }
  appendChildren(inner, node, doc, imageBase);
  return el;
}

function appendChildren(
  into: HTMLElement,
  from: Y.XmlElement | Y.XmlFragment,
  doc: Document,
  imageBase: string,
): void {
  for (const child of from.toArray()) {
    if (child instanceof Y.XmlText) into.append(renderText(child, doc));
    else if (child instanceof Y.XmlElement) into.append(renderElement(child, doc, imageBase));
  }
}

/** The fragment as read-only DOM: one root holding every block. */
export function renderProse(
  fragment: Y.XmlFragment,
  doc: Document,
  imageBase: string,
): HTMLElement {
  const root = doc.createElement('div');
  root.className = `tiptap ProseMirror ${FIRST_PAINT_CLASS}`;
  appendChildren(root, fragment, doc, imageBase);
  return root;
}

/**
 * Draw `ydoc`'s prose into `parent`, and keep drawing it on every change
 * until the editor takes the root over or the scope ends.
 */
export function paintProse(opts: {
  docId: string;
  ydoc: Y.Doc;
  parent: HTMLElement;
  scope: MountScope;
}): HTMLElement {
  const { parent, scope } = opts;
  const fragment = getProseFragment(opts.ydoc);
  const imageBase = docAssetsBase(opts.docId);
  const doc = parent.ownerDocument;
  const root = renderProse(fragment, doc, imageBase);
  parent.append(root);
  const redraw = (): void => {
    if (!root.classList.contains(FIRST_PAINT_CLASS)) {
      stop();
      return;
    }
    root.replaceChildren();
    appendChildren(root, fragment, doc, imageBase);
  };
  const stop = (): void => fragment.unobserveDeep(redraw);
  fragment.observeDeep(redraw);
  scope.onCleanup(() => {
    stop();
    if (root.classList.contains(FIRST_PAINT_CLASS)) root.remove();
  });
  return root;
}
