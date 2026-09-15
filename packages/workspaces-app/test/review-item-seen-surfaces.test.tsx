import { threadReviewItemId } from '@claude-workspaces/core';
import type { Comment, Thread, User } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetailHandlers } from '../src/board/board-detail-render.ts';
import { type BoardTask, CHORES_ID } from '../src/board/board-model.ts';
import {
  LEGACY_REVIEW_ITEM_ID,
  type ReviewThreadItem,
  reviewQueue,
} from '../src/board/board-review-model.ts';
import {
  type WalkthroughHandlers,
  mountWalkthroughIsland,
  walkthroughData,
} from '../src/board/walkthrough-island.tsx';
import { resetReviewItemSeen } from '../src/review-item-seen.ts';
import { ThreadPanel } from '../src/threads.ts';
import { renderTaskDetail } from './support/task-detail.ts';

/**
 * The three places that show a review item, and the one beacon they share.
 *
 * These drive the REAL surfaces and read the REAL request: what a card is
 * wired to is not a property a test of the watcher alone can see, and the
 * thing under test — "the first time the owner's client shows an item" — is
 * exactly the wiring. The body is asserted whole, so a surface that started
 * sending the ask along with the ids would fail here as well as in the
 * server's control.
 *
 * `IntersectionObserver` is faked to report every watched element as on
 * screen at once: the test environment lays nothing out, so a real observer
 * would report
 * nothing and every case below would pass vacuously. When each card reaches
 * the viewport is the browser's judgement; that it is WATCHED, with the right
 * ids, is this file's.
 *
 * All fixtures are synthetic — invented ids and personas.
 */

const WS = 'w-tide';
const NOW = 1_700_000_000_000;

/**
 * Reports everything observed as on screen — one microtask later, and only
 * once it is in the document.
 *
 * Both of those are the real observer's behaviour and both matter here: a
 * surface hands its card to the watcher while building it, so an observer
 * that answered synchronously would be judging a detached element, and
 * `closest('[inert]')` on a detached element is a different question from the
 * one the page is asking.
 */
class EagerObserver {
  constructor(
    private readonly cb: (entries: { target: Element; isIntersecting: boolean }[]) => void,
  ) {}
  private stopped = false;
  observe(el: Element): void {
    queueMicrotask(() => {
      if (this.stopped || !el.isConnected) return;
      this.cb([{ target: el, isIntersecting: true }]);
    });
  }
  unobserve(): void {}
  disconnect(): void {
    this.stopped = true;
  }
}

/**
 * Let renders, effects and the observer's callback land.
 *
 * A preact effect runs after the next frame, so how long that takes is the
 * environment's business and not something to hard-code: the positive cases
 * poll for the beacon with `waitFor`, and this bounded settle is for the two
 * places that have to give a beacon every chance to arrive before asserting
 * that none did. Each of those is followed by the release that makes the same
 * card report, so "nothing yet" can never pass as "nothing ever".
 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  }
};

/** Poll until the page has sent exactly this many beacons. */
const waitForBeacons = (n: number): Promise<void> =>
  vi.waitFor(() => {
    expect(beacons()).toHaveLength(n);
  });

interface SeenPost {
  path: string;
  body: unknown;
}

let posts: SeenPost[] = [];
let realFetch: { global: typeof fetch; window: typeof fetch } | null = null;

/** Every `review-items/viewed` beacon this page sent. */
const beacons = (): SeenPost[] => posts.filter((p) => p.path.endsWith('/review-items/viewed'));

beforeEach(() => {
  resetReviewItemSeen();
  posts = [];
  document.body.innerHTML = '';
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
    EagerObserver as unknown as typeof IntersectionObserver;
  globalThis.history.replaceState(null, '', `/workspaces/${WS}/tasks`);
  // BOTH spellings: the suite's own setup installs its refusal on
  // `globalThis.fetch` and again on `window.fetch` because the two are not the
  // same object under this environment, and a stub on one leaves code that
  // reaches the other dialling the setup's refusal instead.
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    posts.push({
      path: url.split('?')[0] ?? url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  realFetch = { global: globalThis.fetch, window: window.fetch };
  globalThis.fetch = spy;
  window.fetch = spy;
});

afterEach(() => {
  if (realFetch) {
    globalThis.fetch = realFetch.global;
    window.fetch = realFetch.window;
    realFetch = null;
  }
  disposeWalk?.();
  disposeWalk = null;
  resetReviewItemSeen();
});

let seq = 0;
function task(over: Partial<BoardTask> = {}): BoardTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'todo',
    assignee: 'agent',
    goal: CHORES_ID,
    order: seq,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${seq}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

/** A thread an agent declared as a review item, on a doc of its own. */
function threadItem(over: Partial<ReviewThreadItem> = {}): ReviewThreadItem {
  return {
    kind: 'task-thread',
    docId: 'd-tideline',
    threadId: 'th-1',
    taskId: 't-ledger',
    workspaceId: WS,
    reviewItemId: threadReviewItemId('d-tideline', 'th-1', 'c-1'),
    title: 'Move the last reader across',
    ask: 'Hold the old path open another week?',
    askedBy: 'Ledger Keeper',
    since: NOW - 60_000,
    band: 'declared',
    commentId: 'c-1',
    review: { shape: 'review', headline: 'Hold the old path open another week?' },
    ...over,
  } as ReviewThreadItem;
}

function walkHandlers(): WalkthroughHandlers {
  return {
    onAnswer: vi.fn(),
    onReply: vi.fn(),
    onSaveSecrets: vi.fn(),
    onAskOnItem: vi.fn(),
    onQuestionOnItem: vi.fn(),
    onOpenItem: vi.fn(),
    onOpenThread: vi.fn(),
    onStep: vi.fn(),
    onClose: vi.fn(),
  };
}

let disposeWalk: (() => void) | null = null;
/** The queue card, as the cross-board walk shows it. */
function showWalkCard(items: ReviewThreadItem[], tasks: BoardTask[] = []): void {
  const container = document.createElement('div');
  document.body.append(container);
  disposeWalk?.();
  walkthroughData.value = {
    queue: reviewQueue(tasks, items, NOW),
    index: 0,
    progress: { cleared: 0, last: null },
    now: NOW,
    handlers: walkHandlers(),
    secretsGate: 'open',
  };
  disposeWalk = mountWalkthroughIsland(container);
}

function detailHandlers(over: Partial<DetailHandlers> = {}): DetailHandlers {
  return {
    workspaceId: WS,
    onClose: vi.fn(),
    onStatusSet: vi.fn(),
    onTitleCommit: vi.fn(),
    onAnswer: vi.fn(),
    onOpenDoc: vi.fn(),
    onOpenTask: vi.fn(),
    ...over,
  } as DetailHandlers;
}

describe('the queue card in the cross-board walk', () => {
  it('reports the item it is showing, by its derived id, with ids only', async () => {
    showWalkCard([threadItem()]);
    await waitForBeacons(1);
    const [beacon] = beacons();
    expect(beacon.path).toBe(`/workspaces/${WS}/review-items/viewed`);
    // The whole body. No headline, no ask, no answer — the reader's words
    // never leave the page on this request.
    expect(beacon.body).toEqual({
      reviewItemId: threadReviewItemId('d-tideline', 'th-1', 'c-1'),
      taskId: 't-ledger',
    });
  });

  it("names a ticket's own decision by the id every surface derives for it", async () => {
    const decision = task({ assignee: 'human', needs: 'decision', title: 'Rebuild now?' });
    showWalkCard([], [decision]);
    await waitForBeacons(1);
    expect(beacons()[0].body).toEqual({
      reviewItemId: LEGACY_REVIEW_ITEM_ID,
      taskId: decision.id,
    });
  });
});

describe('the item on its task page', () => {
  it('reports the card the panel is showing', async () => {
    const decision = task({ assignee: 'human', needs: 'decision', title: 'Rebuild now?' });
    const container = document.createElement('div');
    document.body.append(container);
    renderTaskDetail(container, decision, detailHandlers());
    await settle();
    // Positive control: the panel really drew a review card.
    expect(container.querySelector('.board-decide-card')).not.toBeNull();
    await settle();
    expect(beacons()).toHaveLength(1);
    expect(beacons()[0].body).toEqual({
      reviewItemId: LEGACY_REVIEW_ITEM_ID,
      taskId: decision.id,
    });
  });

  it('writes one row for an item met on the queue and again on its task page', async () => {
    const decision = task({ assignee: 'human', needs: 'decision', title: 'Rebuild now?' });
    showWalkCard([], [decision]);
    await waitForBeacons(1);
    const container = document.createElement('div');
    document.body.append(container);
    renderTaskDetail(container, decision, detailHandlers());
    await settle();
    // The reader met the same ask twice in one page load. One beacon — the
    // ledger is keyed by the item, not by the surface that drew it.
    expect(beacons()).toHaveLength(1);
  });
});

describe('the item on a doc page', () => {
  const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };
  const declaring = (): Comment => ({
    id: 'c-1',
    author: alice,
    text: 'Raising this before the freeze.',
    ts: NOW - 60_000,
    review: { shape: 'review', headline: 'Hold the old path open another week?' },
  });
  const thread = (): Thread => ({
    id: 'th-1',
    status: 'open',
    anchor: {
      kind: 'element',
      fingerprint: undefined as never,
      snippet: { text: 'the old path still has one reader' },
    },
    comments: [declaring()],
    commentCount: 1,
    lastActivity: NOW - 60_000,
    createdBy: alice,
  });

  const mountDoc = () => {
    globalThis.history.replaceState(null, '', `/workspaces/${WS}/docs/d-tideline`);
    const container = document.createElement('div');
    document.body.append(container);
    const panel = new ThreadPanel({
      container,
      currentUser: alice,
      onThreadClick: vi.fn(),
      onReply: vi.fn(),
      onResolve: vi.fn(),
      onReopen: vi.fn(),
      onReanchor: vi.fn(),
    });
    return panel;
  };

  it('stays silent while the item is folded away, and reports when it is opened', async () => {
    const panel = mountDoc();
    const t = thread();
    panel.setThreads([t]);
    await settle();
    // The card is BUILT — both faces always are — and the folded one is
    // marked `inert`, so nobody has been shown the item yet.
    expect(document.querySelector('.thread-item-card')).not.toBeNull();
    expect(beacons()).toHaveLength(0);

    panel.setActive(t.id);
    await waitForBeacons(1);
    expect(beacons()[0].path).toBe(`/workspaces/${WS}/review-items/viewed`);
    expect(beacons()[0].body).toEqual({
      reviewItemId: threadReviewItemId('d-tideline', 'th-1', 'c-1'),
    });
  });
});
