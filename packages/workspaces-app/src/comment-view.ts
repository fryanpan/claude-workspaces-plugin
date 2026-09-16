/**
 * The one comment header this app draws — who said it, when, and whether it
 * was received.
 *
 * Before this there were four: the review editor's thread card, its thread
 * sheet, the board's discussion stream and the board's ticket items. They
 * agreed about nothing except by coincidence, which is how a feature can be
 * added to "comments" and appear on one surface out of four. Bryan's
 * instruction when he approved the receipt mock was exactly that — *"this
 * should also work in every comment component in the whole site. I assume
 * these are all working off of a common comment component — if not, please
 * make that happen too"*.
 *
 * So the STRUCTURE lives here: which elements, in which order, with the mark
 * after the time. The two variants are class names, because the doc surface
 * and the board surface are styled by different stylesheets and renaming
 * their classes would be a restyling PR wearing a refactor's clothes.
 *
 * What does NOT live here is the wording of the clock. The review editor says
 * "14:05" (a comment you are reading in place, beside the sentence it is
 * about) and the board says "2h ago" (a stream you are catching up on), and
 * those are two right answers to two different questions. The caller words
 * it; this decides where it goes and what sits next to it.
 *
 * The widget draws comments too and cannot import this — it is a separate
 * vanilla bundle with a hard size ceiling. What it shares is the part that
 * would actually hurt to duplicate: the receipt DECISION and the glyph, both
 * in `@claude-workspaces/core`.
 */

import { RECEIPT_SVG, type ReceiptState, receiptTitle } from '@claude-workspaces/core';

/** Which stylesheet is going to dress this. */
export type CommentHeadVariant = 'doc' | 'board';

export interface CommentHeadSpec {
  variant: CommentHeadVariant;
  /** The author's display name, rendered as TEXT — names are untrusted. */
  name: string;
  /** Drawn as the swatch. Omit on a surface that shows no swatch. */
  color?: string;
  /** Already worded by the caller — see the note above. */
  time?: { text: string; title?: string };
  /** The delivery mark, from `receiptState`. Null or absent draws none. */
  receipt?: ReceiptState | null;
}

const CLASSES: Record<CommentHeadVariant, { row: string; name: string; time: string }> = {
  doc: { row: 'author', name: 'name', time: 'time' },
  board: { row: 'board-comment-head', name: 'board-comment-author', time: 'board-comment-when' },
};

/**
 * The mark itself — one grey tick for sent, two for received.
 *
 * `innerHTML` with a module constant, never with anything a person or an
 * agent wrote: `RECEIPT_SVG` is a literal in `@claude-workspaces/core` and no
 * part of it is interpolated.
 */
export function receiptMark(state: ReceiptState): HTMLElement {
  const box = document.createElement('span');
  box.className = 'cw-receipt';
  box.dataset.receipt = state;
  // A title rather than visible words: the ticks are a glance, and a caption
  // beside every comment you wrote is four words of furniture per row.
  box.title = receiptTitle(state);
  box.innerHTML = RECEIPT_SVG;
  return box;
}

/**
 * The author line: swatch, name, time, mark. Extra chips (a review badge)
 * are appended by the caller, after the mark, so the mark stays beside the
 * clock it is about on every surface.
 */
export function commentHead(spec: CommentHeadSpec): HTMLElement {
  const cls = CLASSES[spec.variant];
  const row = document.createElement('div');
  row.className = cls.row;
  if (spec.color !== undefined) {
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    // Assigning a style PROPERTY cannot smuggle extra declarations the way an
    // interpolated style ATTRIBUTE can — the CSS parser drops the whole value
    // if it is not a colour.
    swatch.style.background = spec.color;
    row.append(swatch);
  }
  const name = document.createElement('span');
  name.className = cls.name;
  // Plain text, never HTML: author names are agent-supplied and untrusted.
  name.textContent = spec.name;
  row.append(name);
  if (spec.time) {
    const time = document.createElement('span');
    time.className = cls.time;
    time.textContent = spec.time.text;
    if (spec.time.title !== undefined) time.title = spec.time.title;
    row.append(time);
  }
  if (spec.receipt) row.append(receiptMark(spec.receipt));
  return row;
}
