/**
 * The bar's lines and the status under the chat's list, on the page. Both can
 * hold words still being heard, which grow at the end, so those rows keep
 * their END in view: a label beside a clip, with `lead-chat-styles.ts` pinning
 * the text to the clip's right edge. Every other line keeps its start and its
 * ellipsis. These rows are rewritten with every word heard, and measured again
 * when the chat changes width between words.
 */
import { HEARD, barLines, statusIsHeard, statusLine } from './lead-chat-lines.ts';
import type { NoteLine } from './lead-chat-meeting-view.ts';
import type { LeadChatViewModel } from './lead-chat-view.ts';

/** The left-edge fade goes on only when words are really cut. */
function fitClip(clip: Element): void {
  const words = clip.firstElementChild;
  clip.classList.toggle('lc-cut', !!words && words.clientWidth > clip.clientWidth);
}

const watched = new WeakSet<HTMLElement>();

/** Measure `box`'s clips again whenever it changes width. */
function watchWidth(box: HTMLElement): void {
  if (watched.has(box) || typeof ResizeObserver === 'undefined') return;
  watched.add(box);
  new ResizeObserver(() => {
    for (const clip of box.querySelectorAll('.lc-tail-clip')) fitClip(clip);
  }).observe(box);
}

/** Make `row`, already on the page, show `label` and the end of `text`. */
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
  fitClip(clip);
}

/**
 * The bar's rows are updated in place, never rebuilt: the bar is a button, and
 * a row replaced between a press and its release takes the click with it, so
 * a tap landing while the words redraw would open nothing.
 */
export function drawBarLines(box: HTMLElement, m: LeadChatViewModel): void {
  watchWidth(box);
  const doc = box.ownerDocument;
  const lines = barLines(m);
  lines.forEach((line, i) => {
    let row = box.children[i] as HTMLElement | undefined;
    if (!row) {
      row = doc.createElement('span');
      box.append(row);
    }
    row.className = `lc-bar-line${line.dim ? ' lc-dim' : ''}${line.live ? ' lc-tail' : ''}`;
    let label = row.firstElementChild;
    if (label?.tagName !== 'B') {
      label = doc.createElement('b');
      row.replaceChildren(label);
    }
    label.textContent = `${line.who}: `;
    if (line.live) label.className = 'lc-tail-label';
    else label.removeAttribute('class');
    const rest = label.nextSibling;
    let keep: ChildNode;
    if (line.live) {
      let clip = rest instanceof Element && rest.classList.contains('lc-tail-clip') ? rest : null;
      let words = clip?.firstElementChild;
      if (!clip || !words) {
        clip = doc.createElement('span');
        clip.className = 'lc-tail-clip';
        words = doc.createElement('span');
        words.className = 'lc-tail-text';
        clip.append(words);
        label.after(clip);
      }
      words.textContent = line.text;
      keep = clip;
    } else if (rest && rest.nodeType === doc.TEXT_NODE) {
      rest.textContent = line.text;
      keep = rest;
    } else {
      keep = doc.createTextNode(line.text);
      label.after(keep);
    }
    while (keep.nextSibling) keep.nextSibling.remove();
    if (line.live) fitClip(keep as Element);
  });
  while (box.children.length > lines.length) box.lastElementChild?.remove();
}

/** The meeting's one line of notes, above the typing box. */
export function drawNoteLine(row: HTMLElement, line: NoteLine | null): void {
  watchWidth(row);
  row.replaceChildren();
  row.classList.remove('lc-tail');
  row.classList.toggle('lc-dim', !!line?.dim);
  delete row.dataset.lead;
  delete row.dataset.said;
  if (!line) return;
  if (line.lead) row.dataset.lead = '1';
  if (line.said) row.dataset.said = line.said;
  const label = row.ownerDocument.createElement('b');
  label.textContent = `${line.who}: `;
  if (line.live) showTail(row, label, line.text);
  else row.append(label, line.text);
}

export function drawStatus(status: HTMLElement, m: LeadChatViewModel): void {
  watchWidth(status);
  if (statusIsHeard(m)) {
    const label = status.ownerDocument.createElement('span');
    label.textContent = HEARD;
    showTail(status, label, m.heard);
    return;
  }
  status.classList.remove('lc-tail');
  status.textContent = statusLine(m);
}
