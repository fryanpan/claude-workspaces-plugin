import { editTexts } from './edit/edit-diff-view.ts';
import type { FeedbackWidgetEl } from './widget.ts';

/**
 * A comment's markdown, drawn rendered in a thread's popover on a mock or a
 * dev server: links, bold, italics, inline code, lists and fenced code, as a
 * doc page draws them (`workspaces-app/src/comment-markdown.ts`).
 *
 * The budgeted bundle draws a comment as its escaped words; this rewrites
 * each `.body` it finds from those words. It rides in `mic.js` and
 * `mockup-live.js` beside `widget-ask.ts` rather than in the budgeted bundle,
 * which it would have put over its ceiling (measured in the PR). The app's
 * renderer is not imported: it builds an HTML string and hydrates workspace
 * links through the app's title cache, none of which a guest page has.
 *
 * Comment text is untrusted, so every node is built with `createElement` and
 * text nodes; nothing here parses markup. A link is drawn only for an
 * `http:`, `https:` or `mailto:` address, and anything else stays its words.
 */

export const MD_CSS = [
  '.thread-popover .body p,.thread-popover .body ul,.thread-popover .body ol,.thread-popover .body pre{margin:0 0 4px}',
  '.thread-popover .body>:last-child{margin-bottom:0}',
  '.thread-popover .body ul,.thread-popover .body ol{padding-left:18px}',
  '.thread-popover .body a{color:#0969da}',
  '.thread-popover .body code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f6f8fa;border-radius:3px;padding:0 3px}',
  '.thread-popover .body pre{background:#f6f8fa;border-radius:4px;padding:6px;overflow-x:auto}',
  '.thread-popover .body pre code{padding:0}',
].join('');

/**
 * One inline mark per alternative: code, bold, a link, `*italic*`,
 * `_italic_`. Code is first so its contents are never marked; a link's label
 * and a mark's words are marked again inside.
 */
const INLINE =
  /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])\*([^*\s][^*]*?)\*(?!\*)|(?<!\w)_([^_\s][^_]*?)_(?!\w)/g;

/** The address a link may go to, or null when it may not be a link. */
function safeHref(url: string): string | null {
  try {
    const u = new URL(url, location.href);
    return /^(https?|mailto):$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function el(tag: string, ...kids: Node[]): HTMLElement {
  const e = document.createElement(tag);
  e.append(...kids);
  return e;
}

function inline(text: string): DocumentFragment {
  const out = document.createDocumentFragment();
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    const [whole, code, bold, label, url, star, under] = m;
    let node: Node;
    if (code !== undefined) node = el('code', document.createTextNode(code));
    else if (bold !== undefined) node = el('strong', inline(bold));
    else if (label !== undefined && url !== undefined) {
      const href = safeHref(url);
      if (!href) continue;
      const a = el('a', inline(label)) as HTMLAnchorElement;
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      node = a;
    } else node = el('em', inline(star ?? under ?? ''));
    out.append(text.slice(at, m.index), node);
    at = m.index + whole.length;
  }
  out.append(text.slice(at));
  return out;
}

const FENCE = /^\s{0,3}(```|~~~)/;
const ITEM = /^\s*(?:([-*+])|\d+[.)])\s+(.*)$/;

/** `text` as nodes: paragraphs, lists and fenced code, each line's marks
 *  drawn. A line break inside a paragraph is kept. */
export function renderMarkdown(text: string): DocumentFragment {
  const out = document.createDocumentFragment();
  let para: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let fence: string[] | null = null;
  for (const line of text.replace(/\\\r?\n/g, '\n').split(/\r?\n/)) {
    if (FENCE.test(line)) {
      if (fence) out.append(el('pre', el('code', document.createTextNode(fence.join('\n')))));
      fence = fence ? null : [];
      para = list = null;
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    const item = line.match(ITEM);
    if (item) {
      const tag = item[1] ? 'UL' : 'OL';
      if (list?.tagName !== tag) out.append((list = el(tag)));
      list.append(el('li', inline(item[2] ?? '')));
      para = null;
    } else if (!line.trim()) {
      para = list = null;
    } else {
      if (para) para.append(el('br'));
      else out.append((para = el('p')));
      para.append(inline(line));
      list = null;
    }
  }
  if (fence) out.append(el('pre', el('code', document.createTextNode(fence.join('\n')))));
  return out;
}

/**
 * Draw every comment in the widget's popovers rendered, from now on. The base
 * bundle wrote each `.body` as the comment's escaped words, so its
 * `textContent` is the comment as written. A comment carrying page edits is
 * left alone: `edit/edit-diff-view.ts` finds those by their exact words and
 * draws their `~~` and `**` as a diff. The observer runs before the
 * popover is measured for its place (`widget-threads.ts`), so it is placed at
 * its rendered height.
 */
export function mountCommentMarkdown(widget: FeedbackWidgetEl): void {
  const shadow = widget.shadow;
  if (!shadow || shadow.querySelector('style[data-cw-md]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-cw-md', '');
  style.textContent = MD_CSS;
  shadow.append(style);
  const scan = (): void => {
    const bodies = shadow.querySelectorAll<HTMLElement>(
      '.thread-popover .comment .body:not([data-md])',
    );
    if (bodies.length === 0) return;
    const edits = editTexts(widget);
    for (const body of bodies) {
      body.dataset.md = '';
      if (body.classList.contains('cw-ed') || edits.has(body.textContent ?? '')) continue;
      body.replaceChildren(renderMarkdown(body.textContent ?? ''));
    }
  };
  new MutationObserver(scan).observe(shadow, { childList: true, subtree: true });
  scan();
}
