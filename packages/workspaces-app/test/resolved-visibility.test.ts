/**
 * Settled comments leave the page.
 *
 * Three surfaces have to agree about a resolved thread and they are wired
 * separately, so each is driven here: the anchor highlights (the projection),
 * the balloon margin (which picks its cards from those highlights), and the
 * phone card in the flow. The comments panel is the deliberate exception — it
 * is where a hidden thread stays visible, which is what makes hiding
 * reversible rather than destructive, so a case asserts it keeps the resolved
 * thread it was handed.
 *
 * Every assertion below has a mutation control beside it: the same drive over
 * a thread that is still open. A test that passes for both is not testing the
 * rule.
 */
import { createThread, setStatus } from '@claude-workspaces/core';
import type { Comment, Thread, User } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createSeenTracker } from '../src/comment-seen.ts';
import { anchoredThreads } from '../src/doc/resolved-visibility.ts';
import { type ThreadDecoration, createThreadProjection } from '../src/doc/thread-projection.ts';
import { type MobileReviewOpts, mountMobileReview } from '../src/mobile-review.ts';
import type { InlineThreadCard, ReviewSurface } from '../src/review-surface.ts';
import { ThreadPanel } from '../src/threads.ts';

const NADIA: User = { id: 'u1', name: 'Nadia Okonkwo', kind: 'known', color: '#2e7dd7' };

let seq = 1_700_000_000_000;
function comment(text: string): Comment {
  seq += 1000;
  return { id: `c${seq}`, author: NADIA, text, ts: seq };
}

function plainThread(id: string, status: Thread['status']): Thread {
  const comments = [comment(`what about ${id}`)];
  return {
    id,
    status,
    anchor: {
      kind: 'text-range',
      startRel: new Uint8Array(),
      endRel: new Uint8Array(),
      snippet: { text: `the words under ${id}` },
    } as Thread['anchor'],
    createdBy: NADIA,
    commentCount: comments.length,
    lastActivity: comments[0]?.ts ?? seq,
    comments,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

// --- the shared filter -------------------------------------------------------

describe('which threads an anchored surface may draw', () => {
  const threads = [
    plainThread('open-a', 'open'),
    plainThread('settled', 'resolved'),
    plainThread('open-b', 'open'),
  ];

  it('drops the settled ones and keeps the rest in document order', () => {
    expect(anchoredThreads(threads).map((t) => t.id)).toEqual(['open-a', 'open-b']);
    // The control: the same three threads with nothing resolved keeps all of
    // them, so the absence above is the status and not the filter dropping
    // whatever sits in the middle.
    const allOpen = threads.map((t) => ({ ...t, status: 'open' }) as Thread);
    expect(anchoredThreads(allOpen).map((t) => t.id)).toEqual(['open-a', 'settled', 'open-b']);
  });

  it('never destroys anything — the array it was handed is the same length', () => {
    anchoredThreads(threads);
    expect(threads).toHaveLength(3);
    expect(threads.map((t) => t.status)).toEqual(['open', 'resolved', 'open']);
  });
});

// --- the anchor highlights ---------------------------------------------------

/** A surface whose relative positions are one byte each, so a test can say
 *  where a thread's anchor sits and read the decorations back. */
function fakeSurface() {
  const recorded: ThreadDecoration[][] = [];
  const surface = {
    resolveRel: (start: Uint8Array, end: Uint8Array) => ({
      from: start[0] as number,
      to: end[0] as number,
    }),
    setThreadRanges: (ranges: ThreadDecoration[]) => {
      recorded.push(ranges);
    },
  } as unknown as Pick<ReviewSurface, 'resolveRel' | 'setThreadRanges' | 'lineForPos'>;
  return { surface, last: () => recorded[recorded.length - 1] ?? [] };
}

function docWithOneOfEach(): Y.Doc {
  const ydoc = new Y.Doc();
  const anchor = (from: number, to: number) => ({
    kind: 'text-range' as const,
    startRel: new Uint8Array([from]),
    endRel: new Uint8Array([to]),
    snippet: { text: 'the words it points at' },
  });
  createThread(ydoc, {
    threadId: 'still-open',
    anchor: anchor(2, 6),
    createdBy: NADIA,
    firstComment: { id: 'c-open', text: 'Is the second gate the one by the kiosk?' },
  });
  createThread(ydoc, {
    threadId: 'settled',
    anchor: anchor(10, 14),
    createdBy: NADIA,
    firstComment: { id: 'c-settled', text: 'Thirty days matches the by-law.' },
  });
  setStatus(ydoc, 'settled', 'resolved');
  return ydoc;
}

describe('the highlight on the sentence', () => {
  const project = (ydoc: Y.Doc) => {
    const { surface, last } = fakeSurface();
    const projection = createThreadProjection({
      ydoc,
      surface,
      seen: createSeenTracker({ docId: 'd1' }),
      onPendingExpiry: () => {},
    });
    projection.refreshDecorations(null);
    return { ids: last().map((r) => r.id), collected: projection.collect() };
  };

  it('comes off a thread the moment it is resolved', () => {
    expect(project(docWithOneOfEach()).ids).toEqual(['still-open']);
    // The control: the same doc with that second thread left open decorates
    // both — so the absence above is the status and not a broken anchor at
    // positions 10-14.
    const bothOpen = docWithOneOfEach();
    setStatus(bothOpen, 'settled', 'open');
    expect(project(bothOpen).ids).toEqual(['still-open', 'settled']);
  });

  it('leaves the thread itself in the store, marked resolved', () => {
    const settled = project(docWithOneOfEach()).collected.find((t) => t.id === 'settled');
    expect(settled).toBeTruthy();
    expect(settled?.status).toBe('resolved');
    // The control: the thread the projection DID decorate is not somehow
    // marked resolved too.
    expect(project(docWithOneOfEach()).collected.find((t) => t.id === 'still-open')?.status).toBe(
      'open',
    );
  });
});

// --- the phone's card in the flow -------------------------------------------

function inlineHarness(threads: Thread[]) {
  document.body.innerHTML = `
    <div id="shell"><div id="editor"></div>
      <div id="threads-pane"><div id="threads-list"></div></div></div>`;
  const panel = new ThreadPanel({
    container: document.getElementById('threads-list') as HTMLElement,
    currentUser: NADIA,
    onThreadClick: () => {},
    onReply: () => {},
    onResolve: () => {},
    onReopen: () => {},
    onReanchor: () => {},
  });
  let placed: InlineThreadCard[] = [];
  const opts: MobileReviewOpts = {
    inlineVisible: () => true,
    threads: () => threads,
    resolveRange: (id) => {
      const i = threads.findIndex((t) => t.id === id);
      return i < 0 ? null : { from: i * 10, to: i * 10 + 5 };
    },
    renderCard: (t, pending) => panel.renderThread(t, pending),
    surface: {
      setInlineCards: (cards: InlineThreadCard[]) => {
        placed = cards;
      },
      scrollToPos: () => {},
    } as unknown as MobileReviewOpts['surface'],
    setActive: (id) => panel.setActive(id),
    revealInSheet: () => {},
    openSheet: () => {},
    closeSheet: () => {},
    isSheetOpen: () => false,
  };
  const mobile = mountMobileReview(opts);
  panel.setThreads(threads);
  mobile.refresh();
  return { mobile, panel, placed: () => placed };
}

describe("the phone's list of what is on this screen", () => {
  const threads = [
    plainThread('open-a', 'open'),
    plainThread('settled', 'resolved'),
    plainThread('open-b', 'open'),
  ];

  it('follows the same rule as the margin', () => {
    const hidden = inlineHarness(threads);
    expect(hidden.mobile.inlineThreads().map((t) => t.id)).toEqual(['open-a', 'open-b']);
    expect(hidden.placed().map((c) => c.id)).toEqual(['open-a', 'open-b']);

    // The control: the same middle thread left open IS placed, in document
    // order — so the two assertions above are the status, not a card that
    // never builds in the middle slot.
    const allOpen = threads.map((t) => ({ ...t, status: 'open' }) as Thread);
    const shown = inlineHarness(allOpen);
    expect(shown.mobile.inlineThreads().map((t) => t.id)).toEqual(['open-a', 'settled', 'open-b']);
    expect(shown.placed().map((c) => c.id)).toEqual(['open-a', 'settled', 'open-b']);
  });

  it('keeps the settled thread in the panel list', () => {
    const { panel } = inlineHarness(threads);
    expect(panel.countByStatus().resolved).toBe(1);
    // The control: the count is of what the panel HOLDS, and it still holds
    // both open ones too.
    expect(panel.countByStatus().open).toBe(2);
  });
});
