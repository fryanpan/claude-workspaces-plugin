import type { FeedbackWidgetEl } from '../widget.ts';

/**
 * A page-edit send's comment, shown as what it is: one line saying what was
 * edited, then each change with its deleted words struck and its new words
 * marked (`core/src/page-edits-text.ts` writes the text).
 *
 * The budgeted bundle shows every comment as plain text, which would put the
 * diff's `~~` and `**` in front of the reader. This chunk is loaded whenever
 * the page holds an edit still waiting, so it redraws those comments: the
 * thread popover in full, the panel row as its first line. A comment is
 * found by its words, which the server wrote from the edits, and is built
 * node by node, so nothing in it is read as markup.
 */

export const DIFF_CSS = [
  '.cw-ed del{color:#8c959f}',
  '.cw-ed ins{text-decoration:none;background:rgba(45,164,78,.16);border-radius:2px}',
  '.cw-ed .ln{margin-top:4px;padding-left:10px;border-left:2px solid #eaeef2;overflow-wrap:anywhere}',
].join('');

/** `~~gone~~` and `**new**` in a line of the diff, as nodes. */
function line(text: string): Node[] {
  return text
    .split(/(~~[^~]+~~|\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((part) => {
      const tag = part.startsWith('~~') ? 'del' : part.startsWith('**') ? 'ins' : '';
      if (!tag || part.length < 5) return document.createTextNode(part);
      const e = document.createElement(tag);
      e.textContent = part.slice(2, -2);
      return e;
    });
}

/** Draw `text` into `el`: the whole diff, or only its first line. */
export function drawDiff(el: HTMLElement, text: string, full: boolean): void {
  const [head = '', ...rest] = text.split('\n');
  el.replaceChildren(head);
  el.classList.add('cw-ed');
  if (!full) return;
  for (const l of rest) {
    const d = document.createElement('div');
    d.className = 'ln';
    d.append(...line(l.replace(/^- /, '')));
    el.append(d);
  }
}

/** The words of every comment that carries page edits — also read by
 *  `widget-comment-markdown.ts`, which leaves these comments to this view. */
export function editTexts(widget: FeedbackWidgetEl): Set<string> {
  const out = new Set<string>();
  const threads = widget.client?.ydoc.getMap('threads').toJSON() ?? {};
  for (const t of Object.values(threads) as Array<{ comments?: unknown }>) {
    if (!Array.isArray(t?.comments)) continue;
    for (const c of t.comments as Array<{ text?: unknown; pageEdits?: unknown }>) {
      if (Array.isArray(c?.pageEdits) && typeof c.text === 'string') out.add(c.text);
    }
  }
  return out;
}

/** Redraw the widget's page-edit comments as they appear, from now on. */
export function mountDiffView(widget: FeedbackWidgetEl): void {
  const shadow = widget.shadow;
  const style = document.createElement('style');
  style.textContent = DIFF_CSS;
  shadow.append(style);
  const scan = (): void => {
    const spots = [
      ...shadow.querySelectorAll<HTMLElement>('.thread-popover .comment .body:not(.cw-ed)'),
      ...shadow.querySelectorAll<HTMLElement>('.panel-threads .thread .last:not(.cw-ed)'),
    ];
    if (spots.length === 0) return;
    const texts = editTexts(widget);
    for (const el of spots) {
      const text = el.textContent ?? '';
      if (texts.has(text)) drawDiff(el, text, el.classList.contains('body'));
    }
  };
  new MutationObserver(scan).observe(shadow, { childList: true, subtree: true });
  scan();
}
