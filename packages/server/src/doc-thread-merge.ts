import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';

/**
 * Copying comment threads from one document into another, without losing any.
 *
 * Needed because identity became repo plus path: two documents that were
 * bound to two checkouts of the same file are now one document, and the
 * second one's conversation has to arrive in the first. Nothing about that is
 * a delete — the source document keeps every thread it had, so a link saved
 * against it still opens a page with its comments on it. This copies.
 *
 * **A thread whose text is not in the winner is never dropped.** It lands as
 * an ORPHAN — the same shape a thread takes when the paragraph under it is
 * edited away, and the same one the outdated-comments flow already reads —
 * carrying the anchor it had, so a later re-anchor can still find its home.
 * That is the whole reason the copy re-anchors by snippet rather than by
 * relative position: a `Y.RelativePosition` from another document's CRDT is
 * meaningless in this one, and applying it would silently point every thread
 * at the top of the file.
 *
 * Ids are preserved. A thread id is in saved links, in webhooks, and in every
 * agent's `resolve_thread` call, so a copy that renamed them would break
 * those quietly. A thread whose id is already present in the target is
 * skipped rather than merged: it is the same conversation, and two copies of
 * it is the one outcome worse than one.
 */

export interface ThreadMergeResult {
  /** Threads found in the source. */
  seen: number;
  /** Threads written into the target. */
  copied: number;
  /** Of those, the ones whose text was found and re-anchored. */
  reanchored: number;
  /** Of those, the ones that landed in the outdated-comments flow. */
  orphaned: number;
  /** Threads the target already had under the same id. */
  skipped: number;
}

function threadsOf(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('threads') as Y.Map<Y.Map<unknown>>;
}

/** The text a thread was anchored to, whatever shape its anchor is in. */
export function anchorSnippet(anchor: unknown): string | null {
  if (!anchor || typeof anchor !== 'object') return null;
  const a = anchor as {
    kind?: string;
    snippet?: { text?: string };
    original?: unknown;
  };
  // An orphan carries the anchor it had; its text is still the best evidence
  // of where it belongs, so a thread orphaned in the source can re-anchor in
  // the target rather than arriving orphaned twice over.
  if (a.kind === 'orphan') return anchorSnippet(a.original);
  const text = a.snippet?.text;
  return typeof text === 'string' && text.trim() !== '' ? text : null;
}

/**
 * Deep-copy one thread's stored shape.
 *
 * Written field by field rather than by cloning the Y types, because the
 * timestamps are the point: a copied conversation that arrives stamped with
 * the migration's clock loses the order it happened in, and every activity
 * surface reads those numbers.
 */
function copyThreadMap(source: Y.Map<unknown>, anchor: unknown): Y.Map<unknown> {
  const target = new Y.Map<unknown>();
  for (const key of ['status', 'createdBy', 'createdAt', 'summary']) {
    const v = source.get(key);
    if (v !== undefined) target.set(key, v);
  }
  target.set('anchor', anchor);
  const comments = new Y.Array<Y.Map<unknown>>();
  const from = source.get('comments') as Y.Array<Y.Map<unknown>> | undefined;
  if (from) {
    for (const c of from.toArray()) {
      const copy = new Y.Map<unknown>();
      for (const key of ['id', 'author', 'text', 'ts', 'review', 'edits']) {
        const v = c.get(key);
        if (v !== undefined) copy.set(key, v);
      }
      comments.push([copy]);
    }
  }
  target.set('comments', comments);
  return target;
}

/**
 * Copy every thread from `from` into `into`, re-anchoring by text.
 *
 * The two documents hold two versions of one file, so the text a thread was
 * anchored to is usually still there — and when it is not, the thread becomes
 * an outdated comment rather than a lost one. The count of threads before
 * equals the count after, across the target's own threads plus the orphans:
 * that is the invariant the migration asserts.
 */
export function mergeThreads(from: Y.Doc, into: Y.Doc): ThreadMergeResult {
  const result: ThreadMergeResult = { seen: 0, copied: 0, reanchored: 0, orphaned: 0, skipped: 0 };
  const source = threadsOf(from);
  const target = threadsOf(into);

  const work: Array<{ id: string; map: Y.Map<unknown> }> = [];
  source.forEach((map, id) => {
    result.seen++;
    if (target.has(id)) {
      result.skipped++;
      return;
    }
    work.push({ id, map });
  });

  for (const { id, map } of work) {
    const original = map.get('anchor');
    const needle = anchorSnippet(original);
    let anchor: unknown = null;
    if (needle) {
      // `occurrence: 1` deliberately: a snippet that appears twice in the
      // winner is ambiguous to the resolver, and the first match is a better
      // home for the conversation than the outdated pile.
      const found = prose.resolveTextRangeFromFind(into, { find: needle, occurrence: 1 });
      if (found.ok) {
        anchor = {
          kind: 'text-range',
          startRel: found.startRel,
          endRel: found.endRel,
          snippet: { text: needle },
        };
      }
    }
    if (anchor === null) {
      // The outdated-comments shape, carrying what it was anchored to. A
      // thread with no usable anchor at all still lands — as an orphan whose
      // original is whatever it had, including nothing.
      anchor = { kind: 'orphan', original: original ?? null, lastSeenAt: Date.now() };
      result.orphaned++;
    } else {
      result.reanchored++;
    }
    into.transact(() => {
      target.set(id, copyThreadMap(map, anchor));
    }, 'doc-identity-migration');
    result.copied++;
  }
  return result;
}
