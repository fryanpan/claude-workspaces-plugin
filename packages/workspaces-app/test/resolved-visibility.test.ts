/**
 * Settled comments leave the page, and one control brings them back.
 *
 * Four surfaces have to agree about a resolved thread and they are wired
 * separately, so each is driven here: the anchor highlights (the projection),
 * the balloon margin (which picks its cards from those highlights), the phone
 * card in the flow, and the topbar control that flips all three. The thread
 * list is the deliberate exception — it is where a hidden thread stays
 * visible, which is what makes hiding reversible rather than destructive, so
 * a case asserts it keeps the resolved thread it was handed.
 *
 * Every assertion below has a mutation control beside it: the same drive with
 * the preference the other way, or with the thread still open. A test that
 * passes for both is not testing the rule.
 */
import { createThread, setStatus } from '@claude-workspaces/core';
import type { Comment, Thread, User } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createSeenTracker } from '../src/comment-seen.ts';
import {
  SHOW_RESOLVED_PREF_KEY,
  anchoredThreads,
  onShowResolvedChange,
  resetShowResolvedCache,
  setShowResolved,
  showResolved,
  showResolvedFromStored,
  wireResolvedToggle,
} from '../src/doc/resolved-visibility.ts';
import { type ThreadDecoration, createThreadProjection } from '../src/doc/thread-projection.ts';
import { type MobileReviewOpts, mountMobileReview } from '../src/mobile-review.ts';
import type { InlineThreadCard, ReviewSurface } from '../src/review-surface.ts';
import { ThreadPanel } from '../src/threads.ts';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

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

function clearPref(): void {
  try {
    localStorage.removeItem(SHOW_RESOLVED_PREF_KEY);
  } catch {
    // nothing stored
  }
  resetShowResolvedCache();
}

beforeEach(clearPref);
afterEach(() => {
  clearPref();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

// --- the stored preference ---------------------------------------------------

describe('the stored preference', () => {
  it('hides settled comments until this reader has asked for them', () => {
    expect(showResolvedFromStored(null)).toBe(false);
    expect(showResolvedFromStored('0')).toBe(false);
    // The control: the one stored value that means yes.
    expect(showResolvedFromStored('1')).toBe(true);
  });

  it('persists the choice and tells the mounted surfaces to repaint', () => {
    const repaint = vi.fn();
    const off = onShowResolvedChange(repaint);
    expect(showResolved()).toBe(false);

    setShowResolved(true);
    expect(showResolved()).toBe(true);
    expect(localStorage.getItem(SHOW_RESOLVED_PREF_KEY)).toBe('1');
    expect(repaint).toHaveBeenCalledTimes(1);

    // Control: setting it to what it already is repaints nothing, so a
    // redundant call cannot churn every card on the page.
    setShowResolved(true);
    expect(repaint).toHaveBeenCalledTimes(1);

    setShowResolved(false);
    expect(localStorage.getItem(SHOW_RESOLVED_PREF_KEY)).toBe('0');
    expect(repaint).toHaveBeenCalledTimes(2);
    off();
    setShowResolved(true);
    // Control: an unsubscribed surface stops hearing about it.
    expect(repaint).toHaveBeenCalledTimes(2);
  });
});

// --- the shared filter -------------------------------------------------------

describe('which threads an anchored surface may draw', () => {
  const threads = [
    plainThread('open-a', 'open'),
    plainThread('settled', 'resolved'),
    plainThread('open-b', 'open'),
  ];

  it('drops the settled ones while they are hidden, and keeps them otherwise', () => {
    expect(anchoredThreads(threads, false).map((t) => t.id)).toEqual(['open-a', 'open-b']);
    // The control: nothing is removed once the reader has asked to see them,
    // and the order the document put them in is untouched.
    expect(anchoredThreads(threads, true).map((t) => t.id)).toEqual([
      'open-a',
      'settled',
      'open-b',
    ]);
  });

  it('never destroys anything — the array it was handed is the same length', () => {
    anchoredThreads(threads, false);
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
  const project = (visible: boolean) => {
    const { surface, last } = fakeSurface();
    const projection = createThreadProjection({
      ydoc: docWithOneOfEach(),
      surface,
      seen: createSeenTracker({ docId: 'd1' }),
      onPendingExpiry: () => {},
      showResolved: () => visible,
    });
    projection.refreshDecorations(null);
    return { ids: last().map((r) => r.id), collected: projection.collect() };
  };

  it('comes off a thread the moment it is resolved', () => {
    expect(project(false).ids).toEqual(['still-open']);
    // The control: the same doc, the same resolved thread, the preference the
    // other way — so the absence above is the preference and not a broken
    // anchor.
    expect(project(true).ids).toEqual(['still-open', 'settled']);
  });

  it('leaves the thread itself in the store, marked resolved', () => {
    const settled = project(false).collected.find((t) => t.id === 'settled');
    expect(settled).toBeTruthy();
    expect(settled?.status).toBe('resolved');
    // The control: the thread the projection DID decorate is not somehow
    // marked resolved too.
    expect(project(false).collected.find((t) => t.id === 'still-open')?.status).toBe('open');
  });
});

// --- the phone's card in the flow -------------------------------------------

function inlineHarness(threads: Thread[], visible: boolean) {
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
    getActive: () => panel.getActive(),
    revealInSheet: () => {},
    openSheet: () => {},
    closeSheet: () => {},
    isSheetOpen: () => false,
    showResolved: () => visible,
    listen: (target, type, handler) => target.addEventListener(type, handler),
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
    const hidden = inlineHarness(threads, false);
    expect(hidden.mobile.inlineThreads().map((t) => t.id)).toEqual(['open-a', 'open-b']);
    expect(hidden.placed().map((c) => c.id)).toEqual(['open-a', 'open-b']);

    // The control: revealed, the settled card is back in the flow in document
    // order — so the two assertions above are the preference, not a card that
    // never built.
    const shown = inlineHarness(threads, true);
    expect(shown.mobile.inlineThreads().map((t) => t.id)).toEqual(['open-a', 'settled', 'open-b']);
    expect(shown.placed().map((c) => c.id)).toEqual(['open-a', 'settled', 'open-b']);
  });

  it('keeps the settled thread in the sheet list either way', () => {
    const { panel } = inlineHarness(threads, false);
    expect(panel.countByStatus().resolved).toBe(1);
    // The control: the count is of what the panel HOLDS, and it still holds
    // both open ones too.
    expect(panel.countByStatus().open).toBe(2);
  });
});

// --- the control -------------------------------------------------------------

describe('the "Show resolved (n)" control', () => {
  /** What each of the control's two labels currently reads. */
  function labels(btn: HTMLElement): { long: string; short: string } {
    return {
      long: btn.querySelector('.rt-long')?.textContent ?? '',
      short: btn.querySelector('.rt-short')?.textContent ?? '',
    };
  }

  function button(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.id = 'toggle-resolved';
    btn.className = 'icon-btn resolved-toggle';
    btn.hidden = true;
    document.body.appendChild(btn);
    return btn;
  }

  it('names the count, reveals, and hides again', () => {
    const btn = button();
    const { paint } = wireResolvedToggle({
      btn,
      listen: (t, type, h) => t.addEventListener(type, h),
    });
    paint(3);
    expect(labels(btn).long).toBe('Show resolved (3)');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    // The phone's label carries the same count in the space it has.
    expect(labels(btn).short).toBe('✓ 3');

    btn.click();
    expect(showResolved()).toBe(true);
    expect(labels(btn).long).toBe('Hide resolved (3)');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    // The accessible name says the whole thing whichever label is drawn.
    expect(btn.getAttribute('aria-label')).toBe('Hide 3 resolved comments');

    // The control: pressing it again is the way back, so the reveal is not a
    // one-way door.
    btn.click();
    expect(showResolved()).toBe(false);
    expect(labels(btn).long).toBe('Show resolved (3)');
    expect(btn.getAttribute('aria-label')).toBe('Show 3 resolved comments');
  });

  it('offers nothing on a doc with nothing settled', () => {
    const btn = button();
    const { paint } = wireResolvedToggle({
      btn,
      listen: (t, type, h) => t.addEventListener(type, h),
    });
    paint(0);
    expect(btn.hidden).toBe(true);
    // The control: one resolved thread is enough to bring the control back,
    // so the hiding above is the count and not a control that never shows.
    paint(1);
    expect(btn.hidden).toBe(false);
    expect(labels(btn).long).toBe('Show resolved (1)');
  });

  it('is a word-shaped button that disappears when hidden', () => {
    const cleanup = installSheets('styles.css', 'doc.css');
    const btn = button();
    expect(styleOf(btn).display).toBe('none');
    // The control: the same element, shown, is laid out like the rest of the
    // topbar rather than staying invisible.
    btn.hidden = false;
    expect(styleOf(btn).display).toBe('inline-flex');
    expect(styleOf(btn).whiteSpace).toBe('nowrap');
    cleanup();
  });

  it('drops to the count on a phone and spells it out on the tablet', () => {
    const cleanup = installSheets('styles.css', 'doc.css');
    const btn = button();
    btn.hidden = false;
    wireResolvedToggle({ btn, listen: (t, type, h) => t.addEventListener(type, h) }).paint(2);
    const long = btn.querySelector('.rt-long') as HTMLElement;
    const short = btn.querySelector('.rt-short') as HTMLElement;

    setViewport(PHONE);
    expect(styleOf(long).display).toBe('none');
    expect(styleOf(short).display).toBe('inline');

    // The control: at Bryan's own width the words are the label and the
    // glyph is the one that stands down — so neither assertion above is a
    // rule that never applies.
    setViewport(IPAD);
    expect(styleOf(short).display).toBe('none');
    expect(styleOf(long).display).not.toBe('none');
    cleanup();
    setViewport(IPAD);
  });
});
