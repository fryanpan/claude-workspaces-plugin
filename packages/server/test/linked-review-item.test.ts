/**
 * `linked-review-item.ts` on plain objects: which bodies parse, where each
 * kind of thread opens, and that resolving checks the board the caller named.
 * The route over it is `thread-linked-item.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import type { TaskReviewItem, Thread } from '@claude-workspaces/core';
import {
  type LinkedItemSources,
  parseLinkItemRequest,
  resolveLinkedItem,
  threadItemHref,
} from '../src/linked-review-item.ts';

const ALICE = { id: 'person:alice', name: 'Alice', kind: 'known' as const, color: '#336699' };
const thread = (id: string, review?: { headline: string }): Thread => ({
  id,
  status: 'open',
  anchor: { kind: 'element', context: { url: '/apps/riverbend/settings' } } as never,
  createdBy: ALICE,
  commentCount: 1,
  lastActivity: 1,
  comments: [
    {
      id: 'c1',
      author: ALICE,
      text: 'Look?',
      ts: 1,
      ...(review ? { review: { shape: 'review', ...review } as never } : {}),
    },
  ],
});

const sources = (over: Partial<LinkedItemSources> = {}): LinkedItemSources => ({
  boardName: (ws) => (ws === 'w-b' ? 'Riverbend' : undefined),
  taskBoard: (id) => (id === 't-1' ? 'w-b' : undefined),
  reviewItems: () =>
    [
      { id: 'r-1', review: { headline: 'Ship it?' }, createdAt: 1, createdBy: 'Bob' },
    ] as never as TaskReviewItem[],
  boardsOfDoc: (id) => (id === 'harbor' ? ['w-b'] : []),
  thread: (_doc, id) => (id === 'th-1' ? thread('th-1', { headline: 'Chart readable?' }) : null),
  docType: () => 'app',
  isGoal: () => false,
  ...over,
});

describe('parseLinkItemRequest', () => {
  it('takes exactly one whole kind', () => {
    expect(parseLinkItemRequest({ workspaceId: 'w', taskId: 't', reviewItemId: 'r' })).toEqual({
      workspaceId: 'w',
      taskId: 't',
      reviewItemId: 'r',
    });
    expect(parseLinkItemRequest({ workspaceId: 'w', docId: 'd', threadId: 'th' })).toEqual({
      workspaceId: 'w',
      docId: 'd',
      threadId: 'th',
    });
    for (const bad of [
      null,
      'w',
      [],
      { taskId: 't', reviewItemId: 'r' },
      { workspaceId: 'w' },
      { workspaceId: 'w', taskId: 't' },
      { workspaceId: 'w', taskId: 't', reviewItemId: 'r', threadId: 'th' },
      { workspaceId: 'w', docId: '', threadId: 'th' },
      { workspaceId: 7, docId: 'd', threadId: 'th' },
    ]) {
      expect(parseLinkItemRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('threadItemHref', () => {
  const t = { id: 'th 1', anchor: thread('x').anchor };
  it('opens a task thread at the ticket and a goal thread at the goal', () => {
    expect(threadItemHref('w-b', 'task:t-1', t, undefined, () => false)).toBe(
      '/workspaces/w-b?task=t-1',
    );
    expect(threadItemHref('w-b', 'task:g-1', t, undefined, () => true)).toBe(
      '/workspaces/w-b?goal=g-1',
    );
  });
  it('opens a doc, a mock and an app page at the thread', () => {
    expect(threadItemHref('w-b', 'notes', t, 'markdown', () => false)).toBe(
      '/workspaces/w-b/docs/notes?thread=th%201',
    );
    expect(threadItemHref('w-b', 'tides', t, 'mockup', () => false)).toBe(
      '/workspaces/w-b/mockups/tides?thread=th%201',
    );
    expect(threadItemHref('w-b', 'app', t, 'app', () => false)).toBe(
      '/workspaces/w-b/apps/app/?thread=th%201',
    );
  });
});

describe('resolveLinkedItem', () => {
  it('snapshots a ticket item and a thread item', () => {
    expect(
      resolveLinkedItem({ workspaceId: 'w-b', taskId: 't-1', reviewItemId: 'r-1' }, sources()),
    ).toEqual({
      ok: true,
      item: {
        workspaceId: 'w-b',
        board: 'Riverbend',
        headline: 'Ship it?',
        url: '/workspaces/w-b?task=t-1',
        ref: { taskId: 't-1', reviewItemId: 'r-1' },
      },
    });
    const res = resolveLinkedItem(
      { workspaceId: 'w-b', docId: 'harbor', threadId: 'th-1' },
      sources(),
    );
    expect(res.ok && res.item.headline).toBe('Chart readable?');
  });

  it('answers 404 for another board, and 422 for a snapshot the reader would drop', () => {
    expect(
      resolveLinkedItem(
        { workspaceId: 'w-a', taskId: 't-1', reviewItemId: 'r-1' },
        sources({
          boardName: () => 'Harborlight',
        }),
      ),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      resolveLinkedItem({ workspaceId: 'w-b', docId: 'other', threadId: 'th-1' }, sources()),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      resolveLinkedItem(
        { workspaceId: 'w-b', docId: 'harbor', threadId: 'th-1' },
        sources({ thread: () => thread('th-1', { headline: 'x'.repeat(600) }) }),
      ),
    ).toMatchObject({ ok: false, status: 422 });
  });
});
