import type * as Y from 'yjs';
import { getThreads, readThread } from '../schema.ts';
import type { Anchor, ElementAnchor, Thread } from '../types.ts';

/**
 * Keeping an element thread's anchor up with a page that is rewritten.
 *
 * An anchor records the words, path and attributes its element had when the
 * comment was made. A mock an agent rewrites each round changes a few of an
 * element's words every time, so an anchor matched against its first words
 * soon matches nothing: on one data mock 19 of 29 open threads lost their
 * pins. A page that finds the element with confidence reports what it says
 * now (`widget-anchor-refresh.ts`), and this writes that over the thread's
 * `anchor`, so the next round is matched against the latest words.
 *
 * Only the element's own description moves — its fingerprint and the
 * snippet read off it. The page the thread was made on (`context`) and the
 * spot tapped inside the element (`at`) are the thread's and stay as they
 * were, so no page can move a thread to another page by reporting it. The
 * anchor as first made is kept under `firstAnchor`, written once and never
 * again, so a refresh never overwrites the only copy.
 */

/** The thread map key holding the anchor as first made, once a page has refreshed it. */
export const FIRST_ANCHOR_KEY = 'firstAnchor';

export type AnchorRefresh =
  | { ok: true; thread: Thread; changed: boolean }
  | { ok: false; reason: 'not-found' | 'not-element' | 'other-tag' };

/** What a page can tell from looking at the element, without the box it drew. */
function description(a: ElementAnchor): string {
  const { rect: _rect, ...fp } = a.fingerprint;
  return JSON.stringify(fp);
}

/**
 * Take what a page found `threadId`'s element saying now.
 *
 * Refused for a thread whose anchor is not on an element (an orphan, a
 * subject, a review item), for a words anchor an agent made (`WORDS_TAG`,
 * `*`, whose own resolver finds it), and for an element of another tag than
 * the one the thread is on — a resolver never matches across tags, so a
 * report that does is not one a resolver made. A report matching what the
 * anchor already says writes nothing.
 */
export function refreshAnchor(doc: Y.Doc, threadId: string, seen: ElementAnchor): AnchorRefresh {
  const threadMap = getThreads(doc).get(threadId);
  const thread = threadMap && readThread(threadMap, threadId);
  if (!threadMap || !thread) return { ok: false, reason: 'not-found' };
  const current: Anchor = thread.anchor;
  if (current.kind !== 'element' || current.fingerprint.tag === '*') {
    return { ok: false, reason: 'not-element' };
  }
  if (seen.fingerprint.tag !== current.fingerprint.tag) return { ok: false, reason: 'other-tag' };
  if (description(seen) === description(current)) return { ok: true, thread, changed: false };
  const next: ElementAnchor = { ...current, fingerprint: seen.fingerprint, snippet: seen.snippet };
  doc.transact(() => {
    if (!threadMap.has(FIRST_ANCHOR_KEY)) threadMap.set(FIRST_ANCHOR_KEY, current);
    threadMap.set('anchor', next);
  });
  return { ok: true, thread: readThread(threadMap, threadId) ?? thread, changed: true };
}
