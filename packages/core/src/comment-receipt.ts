/**
 * Whether a comment you wrote was received, and the one mark that says so.
 *
 * The question this answers is the one a person asks the moment a comment
 * leaves their hands: did anyone get it. "Not sent — tap to retry" answers the
 * failure half. This is the other half — the comment DID leave, and the mark
 * says how far it got.
 *
 * Two states, and the WhatsApp convention because it is the one convention
 * everybody already reads: one grey tick, the server has it; two, a session
 * watching this doc has been handed it. Grey in both — a delivery is not an
 * event worth colour. Gone once a reply lands, because a reply is a better
 * answer to "did anyone get this" than any mark could be.
 *
 * It is drawn only for the person who wrote the comment. Everyone else is
 * reading somebody else's conversation, and a delivery receipt on it is
 * bookkeeping about a question they did not ask.
 *
 * Framework-free and DOM-free on purpose: the board, the review editor and
 * the injectable widget all draw comments, the widget cannot import the
 * app, and a second copy of this decision is how two surfaces come to
 * disagree about what a tick means.
 */

/** One tick, or two. There is no third state — see `receiptState`. */
export type ReceiptState = 'sent' | 'received';

/** Whoever is looking. Either half identifies them; see `sameWho`. */
export interface ReceiptReader {
  id?: string;
  name?: string;
}

/**
 * Everything the decision needs from a comment — a structural subset of
 * `Comment`, so the board's projected row (which keeps a name and no `User`)
 * satisfies it without being widened into one.
 */
export interface ReceiptComment {
  id: string;
  ts: number;
  author: { id?: string; name?: string };
  /** Stamped by the server when a watching session was handed this comment. */
  deliveredAt?: number;
}

const norm = (s: string | undefined): string =>
  typeof s === 'string' ? s.trim().toLowerCase() : '';

/**
 * Is this the same person?
 *
 * The id wins whenever BOTH sides carry one: names are agent-supplied and
 * two sessions may run under one display name, so a name match between two
 * known ids is a collision rather than evidence. The board's discussion rows
 * carry only a name (the projection drops the `User`), which is why the name
 * comparison exists at all rather than the id being required.
 */
function sameWho(a: ReceiptReader, b: ReceiptReader): boolean {
  const aId = norm(a.id);
  const bId = norm(b.id);
  if (aId !== '' && bId !== '') return aId === bId;
  const aName = norm(a.name);
  return aName !== '' && aName === norm(b.name);
}

/**
 * The mark this comment carries for this reader, or null for no mark.
 *
 * `thread` is the comments the surface is drawing — the whole thread on the
 * doc side, the row's whole discussion on the board. It is read for one
 * thing: whether somebody else has spoken SINCE. Order is by `ts` rather
 * than by array position, for the reason every other reader of a comment
 * list sorts: a Yjs array's order is a merge order, not a clock.
 */
export function receiptState(
  comment: ReceiptComment,
  thread: ReadonlyArray<ReceiptComment>,
  reader: ReceiptReader | null | undefined,
): ReceiptState | null {
  if (!reader) return null;
  if (!sameWho(reader, comment.author)) return null;
  for (const other of thread) {
    if (other.id === comment.id) continue;
    if (other.ts <= comment.ts) continue;
    if (!sameWho(reader, other.author)) return null;
  }
  return comment.deliveredAt !== undefined ? 'received' : 'sent';
}

/** What the mark says when a reader hovers or a screen reader reaches it. */
export function receiptTitle(state: ReceiptState): string {
  return state === 'received' ? 'Received' : 'Sent';
}

/**
 * The glyph, as markup — ONE definition, mounted two ways.
 *
 * Both ticks are always drawn and the second is hidden by opacity rather
 * than left out, so the box is the same width in both states and the second
 * tick appearing never nudges the time beside it.
 *
 * Inline rather than a sprite or a font: this has to render inside the
 * widget's shadow root on a page whose stylesheets we do not control.
 */
export const RECEIPT_SVG =
  '<svg viewBox="0 0 15 11" width="15" height="11" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  // The back tick is the one the stylesheet reveals; the front one is never
  // addressed, so it carries no class. Both paths are one `M` and two
  // implicit linetos — the shortest spelling of a tick that still reads.
  '<path class="cw-tick-back" d="M.8 6 4 9.2 9.6 2.4"/>' +
  '<path d="M5.2 6 8.4 9.2 14 2.4"/>' +
  '</svg>';

/** The whole mark as markup, for a surface that builds its rows as strings. */
export function receiptHtml(state: ReceiptState): string {
  return `<span class="cw-receipt" data-receipt="${state}" title="${receiptTitle(state)}">${RECEIPT_SVG}</span>`;
}
