/**
 * The cross-board review (`/review`): every open review item on every board,
 * one card at a time, top project first — the "Start review" of the
 * all-workspaces page.
 *
 * The card is the board's walkthrough island, fed a different queue and
 * different chrome. Answers go through the board's own review controller, and
 * each row carries its board, so every write posts to that board's existing
 * route and meets the gates it always met.
 *
 * The queue is re-read before every step as well as after every answer, so
 * an item its filer withdrew never becomes the next card. The rail beside the
 * card is the board's, and goes to the pages of the project the card is from.
 */
import type { ReviewSize } from '@claude-workspaces/core';
import { type BoardNav, navPath } from '../board/board-presence-model.ts';
import { createBoardReviewController } from '../board/board-review-controller.ts';
import { type ReviewItem, advanceWalk } from '../board/board-review-model.ts';
import { NAV_COLLAPSE_HTML, navRailItemsHtml, wireNavCollapse } from '../board/board-shell.ts';
import { mountWalkthroughIsland, walkthroughData } from '../board/walkthrough-island.tsx';
import { browserStorage } from '../boot-env.ts';
import { ensureUserIdentity } from '../identity-prompt.ts';
import { createSizeChoice, httpSizePref } from '../review-sizes.ts';
import { fetchWriteAccess, installWriteGateNotice } from '../signin/write-gate.ts';
import {
  type CrossEntry,
  type CrossReviewRow,
  aimAfterRefresh,
  aimAfterSizeChange,
  allowedEntries,
  asQueue,
  crossEntry,
  crossItemHref,
  hiddenNote,
} from './cross-walk-model.ts';

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
  installWriteGateNotice();
  const writeAccess = await fetchWriteAccess();
  const user = await ensureUserIdentity(
    new URLSearchParams(location.search).get('as'),
    {
      get: (k) => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
    },
    writeAccess.canWrite ? {} : { suppressNamePrompt: true },
  );
  const author = { id: user.id, name: user.name, kind: user.kind, color: user.color };

  let entries: CrossEntry[] = (await fetchQueue()) ?? [];
  // The account's choice arrives after the cache has painted; it re-aims the
  // walk exactly as a tap on the bar would.
  const choice = createSizeChoice(browserStorage, httpSizePref(), (size) => applySize(size));
  let level: ReviewSize = choice.level();
  // The aim, as the board's walk keeps it: a key, and the index it was at, so
  // the card that replaces an answered one is the one that slid into its place.
  const walk: {
    walkIndex: number;
    walkKey: string | null;
    walkProgress: { cleared: number; last: ReviewItem | null };
  } = {
    walkIndex: 0,
    walkKey: allowedEntries(entries, level)[0]?.item.key ?? null,
    walkProgress: { cleared: 0, last: null },
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
    if (size === level) return;
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
    if (fresh) entries = fresh;
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
        backLabel: '‹ Back to Workspaces',
        heading: current ? `Workspace: ${current.project}` : 'Workspaces',
        size: { level, onPick: pickSize },
        doneNote: hiddenNote(entries, level) ?? undefined,
        doneLabel: 'Back to Workspaces',
        tally: false,
      },
      handlers: {
        // No ticket-decision rows reach this page: a legacy decision rides as
        // its `r-legacy` review row, which answers through `onReply`.
        onAnswer: () => Promise.resolve(false),
        onAskOnItem: (item, phrase, question) => review.askOnReviewItem(item, phrase, question),
        onQuestionOnItem: (item, question) => review.askOnReviewItem(item, null, question),
        onReply: async (item, text, optionId) => {
          const wrote = await review.replyToReviewItem(item, text, optionId);
          if (wrote === 'asked') {
            render();
            return true;
          }
          return finish(item.key, next?.item.key ?? null, async () => wrote === 'answered');
        },
        onSaveSecrets: (item, values) =>
          finish(item.key, next?.item.key ?? null, () => review.saveSecretsOnItem(item, values)),
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
}

void boot();
