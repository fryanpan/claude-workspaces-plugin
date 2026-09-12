/**
 * Settled comments are not drawn on the page.
 *
 * A resolved thread used to keep everything an open one has: a card in the
 * margin (or in the flow), and a tinted anchor on the sentence. Nothing was
 * wrong with any single one of them; the failure was cumulative. On a doc
 * that has been through a review round, most of the cards on screen are
 * about questions nobody is asking any more, and the remaining open ones are
 * the needle.
 *
 * Hidden is NOT deleted, and nothing in this module writes to a document. The
 * thread stays in the ydoc and stays in the comments panel under its Resolved
 * tab, which is where a reader goes to read the ones already answered.
 *
 * There was a "Show resolved (n)" control in the top bar and a stored
 * per-device preference behind it. Both are gone: the bar had to fit a phone,
 * and the panel's Resolved tab was already the place settled work is read.
 */
import type { Thread } from '@claude-workspaces/core';

/**
 * The threads an ANCHORED surface may draw: the balloon margin, the inline
 * cards, and the highlights on the prose.
 *
 * One function rather than a filter written out at each call site, because
 * the three surfaces have to agree — a highlight with no card under it, or a
 * card pointing at a sentence with no tint, is worse than either state on its
 * own. The panel's list is deliberately NOT a caller: it is the place a
 * resolved thread stays visible, which is what makes hiding reversible.
 */
export function anchoredThreads(threads: Thread[]): Thread[] {
  return threads.filter((t) => t.status !== 'resolved');
}
