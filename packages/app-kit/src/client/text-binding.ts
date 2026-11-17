/**
 * Binds a <textarea> to a Y.Text: typing becomes one small edit to the
 * shared text, and another tab's edit rewrites the box while the reader's
 * cursor stays on the character it was on.
 */
import type * as Y from 'yjs';
import { splice } from '../text/splice.ts';

export { splice };

type Delta = Array<{ insert?: unknown; delete?: number; retain?: number }>;

/**
 * Where a cursor at `pos` lands after a change described by `delta`. `at`
 * walks the text as it was: a retain or delete moves along it, an insert
 * does not. Text inserted exactly at the cursor goes after it.
 */
export function shiftIndex(delta: Delta, pos: number): number {
  let at = 0;
  let out = pos;
  for (const op of delta) {
    if (at >= pos) break;
    if (op.retain) at += op.retain;
    else if (typeof op.insert === 'string') out += op.insert.length;
    else if (op.delete) {
      out -= Math.min(op.delete, pos - at);
      at += op.delete;
    }
  }
  return out;
}

export function bindTextarea(el: HTMLTextAreaElement, text: Y.Text): () => void {
  const local = {};
  el.value = text.toString();
  const onInput = (): void => {
    const { index, remove, insert } = splice(text.toString(), el.value);
    text.doc?.transact(() => {
      if (remove) text.delete(index, remove);
      if (insert) text.insert(index, insert);
    }, local);
  };
  const onChange = (ev: Y.YTextEvent, tr: Y.Transaction): void => {
    if (tr.origin === local) return;
    const delta = ev.delta as Delta;
    const start = shiftIndex(delta, el.selectionStart);
    const end = shiftIndex(delta, el.selectionEnd);
    el.value = text.toString();
    if (document.activeElement === el) el.setSelectionRange(start, end);
  };
  el.addEventListener('input', onInput);
  text.observe(onChange);
  return () => {
    el.removeEventListener('input', onInput);
    text.unobserve(onChange);
  };
}
