/**
 * The bar's lines and the status under the chat's list, on the page. Both can
 * hold words still being heard, which grow at the end, so those rows keep
 * their END in view: a label beside a clip, with `lead-chat-styles.ts` pinning
 * the text to the clip's right edge. Every other line keeps its start and its
 * ellipsis. These rows are rewritten with every word heard.
 */
import { HEARD, barLines, statusIsHeard, statusLine } from './lead-chat-lines.ts';
import type { LeadChatViewModel } from './lead-chat-view.ts';

/** Make `row`, already on the page, show `label` and the end of `text`. The
 *  left-edge fade goes on only when words are really cut. */
function showTail(row: HTMLElement, label: HTMLElement, text: string): void {
  const doc = row.ownerDocument;
  const clip = doc.createElement('span');
  clip.className = 'lc-tail-clip';
  const words = doc.createElement('span');
  words.className = 'lc-tail-text';
  words.textContent = text;
  clip.append(words);
  label.classList.add('lc-tail-label');
  row.classList.add('lc-tail');
  row.replaceChildren(label, clip);
  clip.classList.toggle('lc-cut', words.offsetWidth > clip.clientWidth);
}

export function drawBarLines(box: HTMLElement, m: LeadChatViewModel): void {
  const doc = box.ownerDocument;
  box.replaceChildren();
  for (const line of barLines(m)) {
    const row = doc.createElement('span');
    row.className = `lc-bar-line${line.dim ? ' lc-dim' : ''}`;
    box.append(row);
    const label = doc.createElement('b');
    label.textContent = `${line.who}: `;
    if (line.live) showTail(row, label, line.text);
    else row.append(label, line.text);
  }
}

export function drawStatus(status: HTMLElement, m: LeadChatViewModel): void {
  if (statusIsHeard(m)) {
    const label = status.ownerDocument.createElement('span');
    label.textContent = HEARD;
    showTail(status, label, m.heard);
    return;
  }
  status.classList.remove('lc-tail');
  status.textContent = statusLine(m);
}
