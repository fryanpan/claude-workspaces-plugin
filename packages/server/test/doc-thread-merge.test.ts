import { describe, expect, it } from 'bun:test';
import { type Thread, createThread, listThreads, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { anchorSnippet, mergeThreads } from '../src/doc-thread-merge.ts';

/**
 * Copying a conversation from one document into another: nothing lost, ids
 * kept, and anything the winner cannot hold landing in the outdated flow.
 *
 * The parity assertion — threads before equals threads after — is the one
 * that matters, so it is made on every case rather than in a test of its own.
 *
 * Fixtures are synthetic.
 */

const AUTHOR = { id: 'u-tester', name: 'Tester', kind: 'known', color: '#336699' } as const;

function docWith(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  prose.applyMarkdownToFragment(prose.getProseFragment(doc), markdown);
  return doc;
}

/** Open a thread on the given text, the way the product does. */
function threadOn(doc: Y.Doc, id: string, find: string, text: string): Thread {
  const found = prose.resolveTextRangeFromFind(doc, { find, occurrence: 1 });
  if (!found.ok) throw new Error(`fixture could not anchor on ${JSON.stringify(find)}`);
  return createThread(doc, {
    threadId: id,
    anchor: {
      kind: 'text-range',
      startRel: found.startRel,
      endRel: found.endRel,
      snippet: { text: find },
    },
    createdBy: AUTHOR,
    firstComment: { id: `c-${id}`, text },
  });
}

const kindOf = (doc: Y.Doc, id: string): string | undefined => {
  const t = (doc.getMap('threads') as Y.Map<Y.Map<unknown>>).get(id);
  return (t?.get('anchor') as { kind?: string } | undefined)?.kind;
};

describe('mergeThreads', () => {
  it('re-anchors a thread whose text is in the winner, and keeps its id and its comments', () => {
    const loser = docWith('# Plan\n\nThe cache is warmed at boot.\n\nUnrelated line.\n');
    threadOn(loser, 't-cache', 'cache is warmed', 'Is this still true after the rewrite?');
    const winner = docWith('# Plan\n\nThe cache is warmed at boot, in parallel.\n');

    const res = mergeThreads(loser, winner);
    expect(res).toMatchObject({ seen: 1, copied: 1, reanchored: 1, orphaned: 0, skipped: 0 });

    const [copied] = listThreads(winner);
    expect(copied?.id).toBe('t-cache');
    expect(copied?.comments.map((c) => c.text)).toEqual(['Is this still true after the rewrite?']);
    expect(kindOf(winner, 't-cache')).toBe('text-range');
    // Parity, and the source keeps its own copy — nothing was moved.
    expect(listThreads(winner)).toHaveLength(1);
    expect(listThreads(loser)).toHaveLength(1);
  });

  it('lands a thread the winner has no text for in the outdated-comments flow', () => {
    const loser = docWith('# Plan\n\nThe cache is warmed at boot.\n');
    threadOn(loser, 't-gone', 'cache is warmed', 'Why at boot?');
    const winner = docWith('# Plan\n\nNothing about caching at all.\n');

    const res = mergeThreads(loser, winner);
    expect(res).toMatchObject({ copied: 1, reanchored: 0, orphaned: 1 });
    // Not dropped: the thread is there, marked the way an edited-away thread
    // is marked, still carrying the anchor it had so it can re-anchor later.
    expect(listThreads(winner).map((t) => t.id)).toEqual(['t-gone']);
    expect(kindOf(winner, 't-gone')).toBe('orphan');
    const anchor = (doc: Y.Doc) =>
      (doc.getMap('threads') as Y.Map<Y.Map<unknown>>).get('t-gone')?.get('anchor') as {
        original?: { snippet?: { text?: string } };
      };
    expect(anchor(winner).original?.snippet?.text).toBe('cache is warmed');
    // PARITY: one thread before, one thread after, across winner plus orphans.
    expect(listThreads(winner)).toHaveLength(1);
  });

  it('keeps every thread when some anchor and some do not', () => {
    const loser = docWith('# Plan\n\nAlpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.\n');
    threadOn(loser, 't-a', 'Alpha paragraph', 'a');
    threadOn(loser, 't-b', 'Beta paragraph', 'b');
    threadOn(loser, 't-c', 'Gamma paragraph', 'c');
    const winner = docWith('# Plan\n\nAlpha paragraph.\n\nGamma paragraph.\n');

    const before = listThreads(loser).length;
    const res = mergeThreads(loser, winner);
    expect(res).toMatchObject({ seen: 3, copied: 3, reanchored: 2, orphaned: 1 });
    expect(listThreads(winner)).toHaveLength(before);
    expect(kindOf(winner, 't-b')).toBe('orphan');
    // CONTROL: the two that did find their text are NOT orphans. Without this
    // an implementation that orphaned everything would pass the parity count.
    expect(kindOf(winner, 't-a')).toBe('text-range');
    expect(kindOf(winner, 't-c')).toBe('text-range');
  });

  it('does not duplicate a conversation the winner already has', () => {
    const loser = docWith('# Plan\n\nShared paragraph.\n');
    threadOn(loser, 't-same', 'Shared paragraph', 'first');
    const winner = docWith('# Plan\n\nShared paragraph.\n');
    threadOn(winner, 't-same', 'Shared paragraph', 'first');

    const res = mergeThreads(loser, winner);
    expect(res).toMatchObject({ seen: 1, copied: 0, skipped: 1 });
    expect(listThreads(winner)).toHaveLength(1);
    expect(listThreads(winner)[0]?.comments).toHaveLength(1);
  });

  it('preserves the times a conversation happened at, not the time it was copied', () => {
    const loser = docWith('# Plan\n\nOld paragraph.\n');
    threadOn(loser, 't-old', 'Old paragraph', 'said long ago');
    // Backdate the stored comment the way a year-old thread reads on disk.
    const stored = (loser.getMap('threads') as Y.Map<Y.Map<unknown>>).get('t-old');
    const comments = stored?.get('comments') as Y.Array<Y.Map<unknown>>;
    const backdated = 1_600_000_000_000;
    loser.transact(() => {
      comments.get(0)?.set('ts', backdated);
      stored?.set('createdAt', backdated);
    });

    const winner = docWith('# Plan\n\nOld paragraph.\n');
    mergeThreads(loser, winner);
    const copied = listThreads(winner)[0];
    expect(copied?.comments[0]?.ts).toBe(backdated);
    expect(copied?.lastActivity).toBe(backdated);
  });

  it('carries a resolved thread across as resolved', () => {
    const loser = docWith('# Plan\n\nSettled paragraph.\n');
    threadOn(loser, 't-done', 'Settled paragraph', 'done');
    loser.transact(() => {
      (loser.getMap('threads') as Y.Map<Y.Map<unknown>>).get('t-done')?.set('status', 'resolved');
    });
    const winner = docWith('# Plan\n\nSettled paragraph.\n');
    mergeThreads(loser, winner);
    expect(listThreads(winner)[0]?.status).toBe('resolved');
  });

  it('reads the text out of an anchor that is already orphaned', () => {
    // A thread orphaned in the loser must get a second chance in the winner,
    // rather than arriving orphaned because it arrived orphaned.
    expect(
      anchorSnippet({ kind: 'orphan', original: { kind: 'text-range', snippet: { text: 'x' } } }),
    ).toBe('x');
    expect(anchorSnippet({ kind: 'text-range', snippet: { text: 'y' } })).toBe('y');
    expect(anchorSnippet({ kind: 'subject' })).toBeNull();
    expect(anchorSnippet(null)).toBeNull();

    const loser = docWith('# Plan\n\nRecovered paragraph.\n');
    threadOn(loser, 't-back', 'Recovered paragraph', 'still relevant');
    const threads = loser.getMap('threads') as Y.Map<Y.Map<unknown>>;
    const original = threads.get('t-back')?.get('anchor');
    loser.transact(() => {
      threads.get('t-back')?.set('anchor', { kind: 'orphan', original, lastSeenAt: 1 });
    });
    const winner = docWith('# Plan\n\nRecovered paragraph.\n');
    const res = mergeThreads(loser, winner);
    expect(res.reanchored).toBe(1);
    expect(kindOf(winner, 't-back')).toBe('text-range');
  });

  it('keeps a subject thread, which has no text to look for at all', () => {
    const loser = docWith('# Plan\n\nAnything.\n');
    createThread(loser, {
      threadId: 't-subject',
      anchor: { kind: 'subject' },
      createdBy: AUTHOR,
      firstComment: { id: 'c-subject', text: 'about the whole doc' },
    });
    const winner = docWith('# Plan\n\nAnything.\n');
    const res = mergeThreads(loser, winner);
    expect(res).toMatchObject({ copied: 1, orphaned: 1 });
    expect(listThreads(winner).map((t) => t.id)).toEqual(['t-subject']);
  });
});
