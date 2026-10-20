/**
 * The cross-board review (`/review`): every open review item on every board,
 * one card at a time, top project first — the "Start review" of the
 * all-workspaces page. A project's group on that page opens the walk at the
 * project's first item (`?from=<workspaceId>`).
 *
 * The card is the board's walkthrough island, fed a different queue and
 * different chrome. Answers go through the board's own review controller, and
 * each row carries its board, so every write posts to that board's existing
 * route and meets the gates it always met.
 *
 * The queue is re-read before every step as well as after every answer, so
 * an item its filer withdrew never becomes the next card, and whenever any
 * board's asks move (`review-live.ts`), so an ask filed or answered elsewhere
 * shows within a second without moving the card the reader is on. The rail
 * beside the card is the board's, and goes to the pages of the project the
 * card is from.
 */
import type { ReviewSize } from '@claude-workspaces/core';
import { type BoardNav, navPath } from '../board/board-presence-model.ts';
import { createBoardReviewController } from '../board/board-review-controller.ts';
import { type ReviewItem, advanceWalk } from '../board/board-review-model.ts';
import { NAV_COLLAPSE_HTML, navRailItemsHtml, wireNavCollapse } from '../board/board-shell.ts';
import { mountWalkthroughIsland, walkthroughData } from '../board/walkthrough-island.tsx';
import { browserStorage } from '../boot-env.ts';
import { mountCoachCard } from '../coach-card.ts';
import { ensureUserIdentity, sessionAnswerOf } from '../identity-prompt.ts';
import { startPageLoadReport } from '../page-load-report.ts';
import { chooseDifficultyOn, createSizeChoice, httpSizePref } from '../review-sizes.ts';
import { fetchWriteAccess, installWriteGateNotice, readSessionBody } from '../signin/write-gate.ts';
import {
  type CrossEntry,
  type CrossReviewRow,
  aimAfterRefresh,
  aimAfterSizeChange,
  allowedEntries,
  asQueue,
  crossEntry,
  crossItemHref,
  startKey,
  walkChrome,
} from './cross-walk-model.ts';
import { mergeLiveQueue, startReviewLive } from './review-live.ts';

async function fetchQueue(): Promise<CrossEntry[] | null> {
  try {
    const res = await fetch('/api/review-queue');
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: CrossReviewRow[] };
    const now = Date.now();
    return (body.items ?? []).flatMap((row) => {
      const entry = crossEntry(row, now);
      return entry ? [entry] : [];
    });
  } catch {
    return null;
  }
}

async function boot(): Promise<void> {
  const host = document.getElementById('board-walkthrough');
  const wsName = document.getElementById('board-ws-name-text');
  if (!host) return;
  // One report per load: its content is the first card, painted from the
  // first queue read. A queue that never came reports at the deadline.
  const loadReport = startPageLoadReport({
    page: 'review',
    workspaceId: null,
  });
  // The queue and the session are read at once, not one after another: the
  // first card waits on the slower of the two rather than on their sum. One
  // session read serves the write gate and the identity both.
  const queued = fetchQueue();
  const session = readSessionBody();
  installWriteGateNotice();
  // The coach hears that he is walking his reviews; it stops itself for anyone else.
  mountCoachCard({ page: 'review' });
  const writeAccess = await fetchWriteAccess(session);
  const user = await ensureUserIdentity(
    new URLSearchParams(location.search).get('as'),
    {
      get: (k) => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
    },
    {
      fetchSession: () => sessionAnswerOf(session),
      ...(writeAccess.canWrite ? {} : { suppressNamePrompt: true }),
    },
  );
  const author = { id: user.id, name: user.name, kind: user.kind, color: user.color };

  const firstQueue = await queued;
  let entries: CrossEntry[] = firstQueue ?? [];
  // Choose-difficulty is off unless this browser turned it on; off, the walk
  // shows everything and never asks the account for a size. On, the account's
  // choice arrives after the cache has painted and re-aims the walk exactly as
  // a tap on the bar would.
  const sizing = chooseDifficultyOn(browserStorage);
  const choice = sizing
    ? createSizeChoice(browserStorage, httpSizePref(), (size) => applySize(size))
    : null;
  let level: ReviewSize = choice?.level() ?? 'hard';
  const params = new URLSearchParams(location.search);
  const from = params.get('from');
  // The aim, as the board's walk keeps it: a key, and the index it was at, so
  // the card that replaces an answered one is the one that slid into its place.
  const walk: {
    walkIndex: number;
    walkKey: string | null;
    walkProgress: { cleared: number; last: ReviewItem | null };
  } = {
    walkIndex: 0,
    walkKey: startKey(allowedEntries(entries, level), from, params.get('item')),
    walkProgress: { cleared: 0, last: null },
  };

  /** The reader's card, when it left the queue elsewhere while open. */
  let closedKey: string | null = null;
  // A live re-read waits out the reader's own write, whose re-read and
  // advance would otherwise race it for the card on screen.
  let writing = 0;
  let liveAgain = false;
  const liveReread = async (): Promise<void> => {
    if (writing > 0) {
      liveAgain = true;
      return;
    }
    const fresh = await fetchQueue();
    if (!fresh) return;
    if (writing > 0) {
      liveAgain = true;
      return;
    }
    const merged = mergeLiveQueue(entries, fresh, walk.walkKey);
    entries = merged.entries;
    closedKey = merged.closedKey;
    render();
  };
  const whileWriting = async <T>(write: () => Promise<T>): Promise<T> => {
    writing += 1;
    try {
      return await write();
    } finally {
      writing -= 1;
      if (writing === 0 && liveAgain) {
        liveAgain = false;
        void liveReread();
      }
    }
  };

  const leave = (): void => location.assign('/');
  const openEntry = (key: string): boolean => {
    const entry = entries.find((e) => e.item.key === key);
    const href = entry ? crossItemHref(entry) : null;
    if (href) location.assign(href);
    return false;
  };

  const review = createBoardReviewController({
    author,
    state: walk,
    currentQueue: () => asQueue(allowedEntries(entries, level)),
    renderWalkthrough: () => render(),
    loadReviewItems: async () => {
      const fresh = await fetchQueue();
      if (fresh) entries = fresh;
    },
    loadDiscussion: async () => {},
    openTaskThread: () => false,
  });

  const pickSize = (size: ReviewSize): void => {
    if (size === level || !choice) return;
    choice.pick(size);
    applySize(size);
  };

  function applySize(size: ReviewSize): void {
    const current = walk.walkKey;
    level = size;
    walk.walkKey = aimAfterSizeChange(entries, current, size);
    walk.walkIndex = walk.walkKey
      ? allowedEntries(entries, size).findIndex((e) => e.item.key === walk.walkKey)
      : allowedEntries(entries, size).length;
    walk.walkProgress = { cleared: walk.walkProgress.cleared, last: null };
    render();
  }

  /** Stepping moves on too, after a re-read (see the header). */
  const step = async (to: number): Promise<void> => {
    const shown = allowedEntries(entries, level).map((e) => e.item.key);
    const fresh = await fetchQueue();
    if (fresh) {
      entries = fresh;
      closedKey = null;
    }
    const visible = allowedEntries(entries, level);
    walk.walkKey = aimAfterRefresh(shown, Math.max(0, to), visible);
    walk.walkIndex = walk.walkKey
      ? visible.findIndex((e) => e.item.key === walk.walkKey)
      : visible.length;
    walk.walkProgress = { cleared: walk.walkProgress.cleared, last: null };
    render();
  };

  // The board's rail, aimed at the project on the card.
  const rail = document.getElementById('board-nav');
  let railWorkspace: string | null = null;
  if (rail) {
    rail.innerHTML = navRailItemsHtml() + NAV_COLLAPSE_HTML;
    wireNavCollapse(document, localStorage);
    for (const btn of rail.querySelectorAll<HTMLButtonElement>('.board-nav-item[data-nav]')) {
      btn.addEventListener('click', () => {
        if (railWorkspace) location.assign(navPath(railWorkspace, btn.dataset.nav as BoardNav));
      });
    }
  }

  /** Answering moves on: the write, the re-read, then the aim at the card
   *  that was next when the answer was sent. */
  const finish = async (
    key: string,
    nextKey: string | null,
    write: () => Promise<boolean>,
  ): Promise<boolean> => {
    const item = entries.find((e) => e.item.key === key)?.item ?? null;
    const ok = await write();
    if (!ok) return false;
    walk.walkProgress = { cleared: walk.walkProgress.cleared + 1, last: item };
    const visible = allowedEntries(entries, level);
    walk.walkIndex = advanceWalk(asQueue(visible), walk.walkIndex, key, nextKey);
    walk.walkKey = visible[walk.walkIndex]?.item.key ?? null;
    render();
    return true;
  };

  function render(): void {
    const visible = allowedEntries(entries, level);
    const queue = asQueue(visible);
    let index = walk.walkKey ? visible.findIndex((e) => e.item.key === walk.walkKey) : -1;
    if (index < 0) index = Math.min(Math.max(walk.walkIndex, 0), visible.length);
    walk.walkIndex = index;
    const current = visible[index] ?? null;
    const next = visible[index + 1] ?? null;
    walk.walkKey = current?.item.key ?? null;
    railWorkspace = current?.workspaceId ?? null;
    for (const btn of rail?.querySelectorAll<HTMLButtonElement>('[data-nav]') ?? []) {
      btn.disabled = railWorkspace === null;
    }
    if (wsName) wsName.textContent = current ? current.project : 'Workspaces';
    document.title = current ? `Review · ${current.project}` : 'Review · Workspaces';
    walkthroughData.value = {
      queue,
      index,
      progress: walk.walkProgress,
      now: Date.now(),
      secretsGate: 'open',
      chrome: {
        ...walkChrome(current, entries, { on: sizing, level, onPick: pickSize }),
        ...(current && current.item.key === closedKey ? { closed: true } : {}),
      },
      handlers: {
        // No ticket-decision rows reach this page: a legacy decision rides as
        // its `r-legacy` review row, which answers through `onReply`.
        onAnswer: () => Promise.resolve(false),
        onAskOnItem: (item, phrase, question) =>
          whileWriting(() => review.askOnReviewItem(item, phrase, question)),
        onQuestionOnItem: (item, question) =>
          whileWriting(() => review.askOnReviewItem(item, null, question)),
        onReply: (item, text, optionId) =>
          whileWriting(async () => {
            const wrote = await review.replyToReviewItem(item, text, optionId);
            if (wrote === 'asked') {
              render();
              return true;
            }
            return finish(item.key, next?.item.key ?? null, async () => wrote === 'answered');
          }),
        onSaveSecrets: (item, values) =>
          whileWriting(() =>
            finish(item.key, next?.item.key ?? null, () => review.saveSecretsOnItem(item, values)),
          ),
        onGrant: (item, decision) =>
          whileWriting(() =>
            finish(item.key, next?.item.key ?? null, () => review.grantOnItem(item, decision)),
          ),
        onOpenItem: (item) => {
          openEntry(item.key);
        },
        onOpenThread: (item) => {
          openEntry(item.key);
        },
        onStep: (i) => {
          void step(i);
        },
        onClose: leave,
      },
    };
  }

  mountWalkthroughIsland(host);
  render();
  if (firstQueue !== null) loadReport.contentShown();
  startReviewLive(liveReread);
}

void boot();
