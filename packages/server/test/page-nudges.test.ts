/**
 * `page-nudges.ts` driven directly: which changes count, and how a burst
 * coalesces. The frames reaching a real stream are `page-nudges-live.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import type { DocIndexEntry } from '../src/doc-index.ts';
import {
  boardsWithChangedMembers,
  createPageNudger,
  listingChanged,
  memberFaces,
  setsOf,
  wirePageNudges,
} from '../src/page-nudges.ts';
import { waitFor } from './wait-for.ts';

function row(meta: Partial<DocIndexEntry['meta']>, open = 0): DocIndexEntry {
  return {
    v: 1,
    meta: { docId: 'd-1', type: 'markdown', createdAt: 1, ...meta },
    threads: { open, total: open },
  };
}

describe('which listing changes count', () => {
  it('a title, a set or a badge is news; a content save is not', () => {
    const a = row({ title: 'Harborlight' });
    expect(listingChanged(a, row({ title: 'Harborlight' }))).toBe(false);
    expect(listingChanged(a, row({ title: 'Riverbend' }))).toBe(true);
    expect(listingChanged(a, row({ title: 'Harborlight' }, 1))).toBe(true);
    expect(listingChanged(undefined, a)).toBe(true);
    expect(listingChanged(a, undefined)).toBe(true);
    expect(listingChanged(a, { ...a, pendingFileWrite: true })).toBe(false);
  });

  it('whether the board made a doc is news: it moves the doc onto Recently Created', () => {
    const bound = row({ title: 'Harborlight', seededFromFile: true });
    expect(listingChanged(bound, row({ title: 'Harborlight', seededFromFile: false }))).toBe(true);
  });

  it('names every set a row left or joined', () => {
    expect(setsOf({ workspaceId: 's-1' }, { setId: 's-2', workspaceId: 's-1' })).toEqual([
      's-1',
      's-2',
    ]);
    expect(setsOf(undefined, {})).toEqual([]);
  });
});

describe('members', () => {
  it('names the boards whose roster or levels moved, and no other', () => {
    const before = memberFaces([
      { workspaceId: 'w-1', email: 'riverbend@example.com' },
      { workspaceId: 'w-2', email: 'saltmarsh@example.com' },
    ]);
    const after = memberFaces([
      { workspaceId: 'w-1', email: 'riverbend@example.com', role: 'owner' },
      { workspaceId: 'w-2', email: 'saltmarsh@example.com' },
      { workspaceId: 'w-3', email: 'harborlight@example.com' },
    ]);
    expect(boardsWithChangedMembers(before, after).sort()).toEqual(['w-1', 'w-3']);
    expect(boardsWithChangedMembers(after, new Map())).toEqual(['w-1', 'w-2', 'w-3']);
  });
});

describe('the nudger', () => {
  it('sends one frame per channel and event for a burst', async () => {
    const sent: string[] = [];
    const n = createPageNudger({ send: (c, f) => sent.push(`${c} ${f.event}`), coalesceMs: 5 });
    for (let i = 0; i < 10; i++) n.nudge('ws~w-1', 'library.changed');
    n.nudge('ws~w-2', 'library.changed');
    await waitFor(() => sent.length === 2);
    expect(sent.sort()).toEqual(['ws~w-1 library.changed', 'ws~w-2 library.changed']);
    n.nudge('ws~w-1', 'library.changed');
    await waitFor(() => sent.length === 3);
    n.dispose();
  });

  it('chains onto hooks that were already there', () => {
    const calls: string[] = [];
    const nudged: string[] = [];
    const docStore = {
      onIndexChanged: (docId: string) => void calls.push(`index ${docId}`),
    } as { onIndexChanged?: (d: string, p?: DocIndexEntry, n?: DocIndexEntry) => void };
    const sse = {
      tap: () => () => {},
      onAgentStreams: ((c: string) => void calls.push(`agents ${c}`)) as
        | ((c: string, a: string) => void)
        | null,
    };
    const wired = wirePageNudges({
      nudger: { nudge: (c, e) => void nudged.push(`${c} ${e}`), dispose: () => {} },
      docStore,
      taskStore: { onBoardDocsChanged: null },
      boardsHolding: () => ['w-1'],
      shareLinks: { onSaved: null, allMembers: () => [] },
      sse,
    });
    docStore.onIndexChanged?.('d-1', undefined, row({ workspaceId: 's-1' }));
    sse.onAgentStreams?.('ws~w-1', 'saltmarsh');
    expect(calls).toEqual(['index d-1', 'agents ws~w-1']);
    expect(nudged).toEqual([
      'ws~s-1 attachments.changed',
      'ws~w-1 library.changed',
      'voice~ voice.changed',
    ]);
    wired.dispose();
  });
});
