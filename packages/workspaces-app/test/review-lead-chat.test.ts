/**
 * Which lead the cross-board review's chat talks to, and how it changes
 * board: the card's board, else the plan board; a new board's chat is
 * swapped in only once it has answered, the old one torn down first; and a
 * message carries the card's item only while the card is on that board.
 * The client and the mount are fakes — no network, no shadow DOM.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LeadChatClient, LeadChatState } from '../src/lead-chat/lead-chat-client.ts';
import type { LeadChatMountOpts } from '../src/lead-chat/lead-chat-mount.ts';
import type { CrossEntry } from '../src/reviews/cross-walk-model.ts';
import {
  createReviewLeadChat,
  leadChatBoard,
  reviewItemContext,
} from '../src/reviews/review-lead-chat.ts';

const ME = { id: 'known-alice', name: 'Alice', kind: 'known' };

function entry(
  workspaceId: string,
  kind: 'task-review' | 'task-thread' | 'doc-thread',
): CrossEntry {
  const thread =
    kind === 'task-review'
      ? { kind, taskId: 't-tide', reviewItemId: 'ri-1' }
      : kind === 'task-thread'
        ? { kind, taskId: 't-tide', threadId: 'th-1' }
        : { kind, docId: 'd-chart', threadId: 'th-2' };
  return {
    workspaceId,
    project: workspaceId,
    size: 'easy',
    item: {
      key: `${workspaceId}:${kind}`,
      kind,
      title: 'Tide table',
      ask: '',
      why: '',
      since: 0,
      thread: { ...thread, workspaceId } as never,
    },
  } as CrossEntry;
}

function fakeClient(workspaceId: string, loaded: boolean) {
  let state = { loaded, workspaceId } as unknown as LeadChatState;
  const fns: Array<(s: LeadChatState) => void> = [];
  let closed = false;
  const client = {
    state: () => state,
    onChange: (fn: (s: LeadChatState) => void) => void fns.push(fn),
    close: () => {
      closed = true;
    },
  } as unknown as LeadChatClient;
  return {
    workspaceId,
    client,
    answer() {
      state = { ...state, loaded: true };
      for (const fn of fns) fn(state);
    },
    closed: () => closed,
  };
}

function rig(opts: { loaded?: boolean } = {}) {
  const dock = document.createElement('div');
  document.body.append(dock);
  const clients: Array<ReturnType<typeof fakeClient>> = [];
  const log: string[] = [];
  const mounts: LeadChatMountOpts[] = [];
  const timers: Array<() => void> = [];
  const chat = createReviewLeadChat({
    dock,
    author: ME,
    createClient: (ws) => {
      const c = fakeClient(ws, opts.loaded ?? false);
      clients.push(c);
      return c.client;
    },
    mount: (o) => {
      mounts.push(o);
      log.push(`mount ${o.workspaceId}`);
      return {
        view: {} as never,
        startMeeting() {},
        destroy: () => log.push(`destroy ${o.workspaceId}`),
      };
    },
    setTimeout: (fn) => timers.push(fn),
  });
  return { dock, clients, log, mounts, timers, chat };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the board the review chat talks to', () => {
  it('is the card’s board, else the plan board, else none', () => {
    expect(leadChatBoard({ workspaceId: 'w-river' }, 'w-plan')).toBe('w-river');
    expect(leadChatBoard(null, 'w-plan')).toBe('w-plan');
    expect(leadChatBoard(null, undefined)).toBeNull();
  });
});

describe('the review chat changing board', () => {
  it('mounts the card’s board only once its chat has answered, in the dock', () => {
    const r = rig();
    r.chat.aim(entry('w-river', 'task-review'), 'w-plan');
    expect(r.clients.map((c) => c.workspaceId)).toEqual(['w-river']);
    expect(r.log).toEqual([]);
    r.clients[0]?.answer();
    expect(r.log).toEqual(['mount w-river']);
    expect(r.mounts[0]?.client).toBe(r.clients[0]?.client);
    expect(r.mounts[0]?.dock?.parentElement).toBe(r.dock);
  });

  it('keeps the old board’s chat until the new one answers, then tears it down first', () => {
    const r = rig();
    r.chat.aim(entry('w-river', 'task-review'), null);
    r.clients[0]?.answer();
    const firstHost = r.mounts[0]?.dock;
    r.chat.aim(entry('w-harbor', 'task-thread'), null);
    expect(r.log).toEqual(['mount w-river']);
    r.clients[1]?.answer();
    expect(r.log).toEqual(['mount w-river', 'destroy w-river', 'mount w-harbor']);
    // Each board's button gets a slot of its own; the old slot is gone.
    expect(firstHost?.isConnected).toBe(false);
    expect(r.dock.children).toHaveLength(1);
  });

  it('reads nothing again for another card on the same board', () => {
    const r = rig({ loaded: true });
    r.chat.aim(entry('w-river', 'task-review'), null);
    r.chat.aim(entry('w-river', 'doc-thread'), null);
    expect(r.clients).toHaveLength(1);
    expect(r.log).toEqual(['mount w-river']);
  });

  it('talks to the plan board’s lead with no card, and to nobody with no plan board', () => {
    const r = rig({ loaded: true });
    r.chat.aim(null, 'w-plan');
    expect(r.log).toEqual(['mount w-plan']);
    r.chat.aim(null, null);
    expect(r.log).toEqual(['mount w-plan', 'destroy w-plan']);
    expect(r.dock.children).toHaveLength(0);
  });

  it('drops a board it moved away from before that board answered', () => {
    const r = rig();
    r.chat.aim(entry('w-river', 'task-review'), null);
    r.chat.aim(entry('w-harbor', 'task-review'), null);
    expect(r.clients[0]?.closed()).toBe(true);
    r.clients[0]?.answer();
    expect(r.log).toEqual([]);
    r.clients[1]?.answer();
    expect(r.log).toEqual(['mount w-harbor']);
  });

  it('swaps in a board that never answers at the deadline', () => {
    const r = rig();
    r.chat.aim(entry('w-river', 'task-review'), null);
    expect(r.timers).toHaveLength(1);
    r.timers[0]?.();
    expect(r.log).toEqual(['mount w-river']);
    // The answer arriving later mounts nothing twice.
    r.clients[0]?.answer();
    expect(r.log).toEqual(['mount w-river']);
  });

  it('sends the card’s item only while the card is on the chat’s board', () => {
    const r = rig({ loaded: true });
    r.chat.aim(entry('w-river', 'task-review'), null);
    const context = r.mounts[0]?.getContext;
    expect(context?.()).toMatchObject({ surface: 'task', taskId: 't-tide', reviewItemId: 'ri-1' });
    // The card moved to another board whose chat has not answered yet.
    const late = rig();
    late.chat.aim(entry('w-river', 'task-review'), null);
    late.clients[0]?.answer();
    late.chat.aim(entry('w-harbor', 'task-thread'), null);
    expect(late.mounts[0]?.getContext?.()).toEqual({ surface: 'board' });
  });
});

describe('what a message says the reader has open', () => {
  it('names the item as the board does, with its link on its board', () => {
    expect(reviewItemContext(entry('w-river', 'task-review'))).toEqual({
      surface: 'task',
      taskId: 't-tide',
      reviewItemId: 'ri-1',
      link: '/workspaces/w-river?task=t-tide',
    });
    expect(reviewItemContext(entry('w-river', 'task-thread'))).toEqual({
      surface: 'task',
      taskId: 't-tide',
      threadId: 'th-1',
      link: '/workspaces/w-river?task=t-tide&thread=th-1',
    });
    expect(reviewItemContext(entry('w-river', 'doc-thread'))).toMatchObject({
      surface: 'doc',
      docId: 'd-chart',
      threadId: 'th-2',
    });
    expect(reviewItemContext(null)).toBeUndefined();
  });
});
