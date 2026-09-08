import type { Comment, ReviewPayload, Thread, User } from '@claude-workspaces/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type HintItem,
  mountCommentHints,
  pillCount,
  splitNotes,
  splitOffscreen,
} from '../src/comment-hints.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * The measurement behind the new-content indicator: what has been written
 * that the reader cannot see, and which way it lies. The tallies are pure and
 * pinned here; the mount is exercised against a hand-measured DOM because
 * happy-dom lays nothing out — every rect below is stubbed.
 */

const item = (id: string, top: number, over: Partial<HintItem> = {}): HintItem => ({
  id,
  kind: 'comment',
  isNew: false,
  top,
  bottom: top + 20,
  ...over,
});

describe('splitOffscreen', () => {
  const view = { top: 0, bottom: 600 };

  it('counts what is wholly above and wholly below, and leaves the visible alone', () => {
    const split = splitOffscreen(
      [item('a', -100), item('b', -30), item('c', 100), item('d', 590), item('e', 700)],
      view,
    );
    expect(split.above.comments).toBe(2);
    expect(split.below.comments).toBe(1);
    // `d` straddles the bottom edge — still visible.
    expect(split.inView).toEqual(['c', 'd']);
  });

  it('separates questions from comments, and counts new ones', () => {
    const split = splitOffscreen(
      [
        item('a', -100, { kind: 'question' }),
        item('b', -50, { isNew: true }),
        item('c', 700, { kind: 'answered', isNew: true }),
        item('d', 800, { kind: 'resolved' }),
      ],
      view,
    );
    expect(split.above).toEqual({ comments: 1, questions: 1, fresh: 1, freshComments: 1 });
    // Answered and resolved are comments as far as the count goes — nothing
    // is waiting on the reader there.
    expect(split.below).toEqual({ comments: 2, questions: 0, fresh: 1, freshComments: 1 });
  });

  it('a new question is counted as a question and NOT also as new', () => {
    // The pill reads "1 question · N new"; counting the same thread in both
    // halves would tell the reader to look for two things.
    const split = splitOffscreen(
      [item('a', -100, { kind: 'question', isNew: true }), item('b', -50, { isNew: true })],
      view,
    );
    expect(split.above.fresh).toBe(2);
    expect(split.above.freshComments).toBe(1);
  });

  it('names the NEAREST off-screen thread in each direction', () => {
    const split = splitOffscreen(
      [item('a', -300), item('b', -100), item('c', 700), item('d', 900)],
      view,
    );
    expect(split.nearestAbove).toBe('b');
    expect(split.nearestBelow).toBe('c');
  });

  it('has no nearest when nothing is off-screen', () => {
    const split = splitOffscreen([item('a', 10)], view);
    expect(split.nearestAbove).toBe(null);
    expect(split.nearestBelow).toBe(null);
  });
});

describe('splitNotes', () => {
  const view = { top: 0, bottom: 600 };
  const note = (top: number) =>
    ({ el: document.createElement('p'), top, bottom: top + 40 }) as never;

  it('counts the freshly written blocks each side, and names the nearest', () => {
    const near = note(-60);
    const far = note(700);
    const split = splitNotes([note(-400), near, far, note(900)], view);
    expect([split.above, split.below]).toEqual([2, 2]);
    expect(split.nearestAbove).toBe(near);
    expect(split.nearestBelow).toBe(far);
  });

  it('a block straddling an edge is on screen', () => {
    const split = splitNotes([note(590), note(-20)], view);
    expect([split.above, split.below]).toEqual([0, 0]);
  });
});

describe('what one pill says', () => {
  it('counts an open ask in its own word and everything else as new', () => {
    // A question is not also counted as "new": the reader would read the
    // same thread twice in one sentence.
    expect(pillCount({ comments: 3, questions: 1, fresh: 3, freshComments: 2 }, 0)).toEqual({
      questions: 1,
      fresh: 2,
    });
  });

  it('folds freshly written notes into the same number', () => {
    expect(pillCount({ comments: 0, questions: 0, fresh: 0, freshComments: 0 }, 4)).toEqual({
      questions: 0,
      fresh: 4,
    });
  });

  it('an old comment nobody has replied to is not new', () => {
    expect(pillCount({ comments: 5, questions: 0, fresh: 0, freshComments: 0 }, 0)).toEqual({
      questions: 0,
      fresh: 0,
    });
  });
});

// --- the mount -------------------------------------------------------------

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };
let ts = 1_700_000_000_000;
function comment(text: string, review?: ReviewPayload): Comment {
  ts += 1000;
  return { id: `c${ts}`, author: alice, text, ts, ...(review ? { review } : {}) };
}
function thread(id: string, comments: Comment[], status: Thread['status'] = 'open'): Thread {
  return {
    id,
    status,
    anchor: { kind: 'subject' },
    commentCount: comments.length,
    lastActivity: comments[comments.length - 1]?.ts ?? ts,
    createdBy: alice,
    comments,
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  vi.useRealTimers();
});

function harness(
  threads: Thread[],
  tops: Record<string, number>,
  opts: {
    margin?: boolean;
    dock?: number;
    cards?: Record<string, Element[]>;
    /** Tops of the tinted note blocks in the prose. */
    notes?: number[];
  } = {},
) {
  const pane = document.createElement('section');
  pane.id = 'editor-pane';
  pane.getBoundingClientRect = () =>
    ({ top: 0, bottom: 820, left: 0, right: 800, width: 800, height: 820 }) as DOMRect;
  const dock = document.createElement('div');
  dock.className = 'plan-float';
  dock.getBoundingClientRect = () =>
    ({ top: opts.dock ?? 0, bottom: (opts.dock ?? 0) + 60, height: opts.dock ? 60 : 0 }) as DOMRect;
  pane.appendChild(dock);
  const scroller = document.createElement('div');
  scroller.id = 'editor';
  pane.appendChild(scroller);
  const marginEl = document.createElement('div');
  marginEl.className = 'markup-margin';
  scroller.appendChild(marginEl);
  const noteEls = (opts.notes ?? []).map((top) => {
    const p = document.createElement('p');
    p.className = 'recent-note';
    p.getBoundingClientRect = () => ({ top, bottom: top + 30 }) as DOMRect;
    p.scrollIntoView = () => noteJumps.push(top);
    scroller.appendChild(p);
    return p;
  });
  document.body.append(pane);
  cleanups.push(() => pane.remove());
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800 }) as DOMRect;
  marginEl.getBoundingClientRect = () =>
    ({ top: 0, bottom: 600, left: 540, right: 800, width: 260 }) as DOMRect;
  const spans = new Map<string, HTMLElement>();
  for (const [id, top] of Object.entries(tops)) {
    const span = document.createElement('span');
    span.getBoundingClientRect = () => ({ top, bottom: top + 20 }) as DOMRect;
    spans.set(id, span);
  }
  const fresh = new Set(threads.filter((t) => t.id.startsWith('new')).map((t) => t.id));
  const seen: string[] = [];
  const jumps: string[] = [];
  const noteJumps: number[] = [];
  const scope = new MountScope();
  cleanups.push(() => scope.dispose());
  const hints = mountCommentHints({
    scroller,
    marginEl: opts.margin === false ? null : marginEl,
    floatParent: pane,
    threads: () => threads,
    spanFor: (id) => spans.get(id) ?? null,
    isNew: (t) => fresh.has(t.id),
    markSeen: (t) => {
      const was = fresh.delete(t.id);
      if (was) seen.push(t.id);
      return was;
    },
    onSeen: () => {},
    onJump: (id) => jumps.push(id),
    dockEl: () => (opts.dock ? dock : null),
    cardsFor: (id) => opts.cards?.[id] ?? [],
    scope,
    dwellMs: 50,
    marginVisible: () => opts.margin !== false,
    reducedMotion: () => true,
  });
  const pill = (which: 'top' | 'bottom') =>
    pane.querySelector<HTMLElement>(`.cw-edge-${which}`) as HTMLElement;
  return { hints, pane, scroller, marginEl, seen, jumps, noteJumps, noteEls, threads, pill };
}

const q = (): ReviewPayload => ({ shape: 'review', headline: 'Why?' });

describe('mountCommentHints', () => {
  it('says how many new things lie each way, in words, and nothing at zero', () => {
    const h = harness(
      [thread('new1', [comment('x')]), thread('new2', [comment('y')]), thread('c', [comment('z')])],
      { new1: -200, new2: -160, c: 300 },
    );
    expect(h.pill('top').hidden).toBe(false);
    expect(h.pill('top').textContent).toContain('2 new');
    expect(h.pill('top').title).toBe('2 new above');
    // Nothing new below — `c` is an old comment the reader has already read.
    expect(h.pill('bottom').hidden).toBe(true);
  });

  it('names an unanswered ask separately, and only then goes amber', () => {
    const h = harness([thread('a', [comment('?', q())]), thread('new1', [comment('x')])], {
      a: 900,
      new1: 950,
    });
    expect(h.pill('bottom').textContent?.replace(/\s+/g, ' ')).toContain('1 question · 1 new');
    expect(h.pill('bottom').classList.contains('has-ask')).toBe(true);
    expect(h.pill('top').classList.contains('has-ask')).toBe(false);
  });

  it('counts freshly written notes in the same number as the comments', () => {
    const h = harness([thread('new1', [comment('x')])], { new1: -200 }, { notes: [-400, -300] });
    expect(h.pill('top').dataset.fresh).toBe('3');
    expect(h.pill('top').textContent).toContain('3 new');
  });

  it('a tap goes to the nearest new thing that way, note or thread', () => {
    const h = harness(
      [thread('new1', [comment('x')]), thread('new2', [comment('y')])],
      { new1: -400, new2: 900 },
      { notes: [-100, 700] },
    );
    // A note sits closer to each edge than either thread does, so the pill
    // that counted it has to be able to reach it.
    h.pill('top').click();
    h.pill('bottom').click();
    expect(h.jumps).toEqual([]);
    expect(h.noteJumps).toEqual([-100, 700]);
  });

  it('…and falls back to the nearest thread when no note is nearer', () => {
    const h = harness(
      [thread('new1', [comment('x')]), thread('new2', [comment('y')])],
      { new1: -100, new2: 700 },
      { notes: [-500, 1200] },
    );
    h.pill('top').click();
    h.pill('bottom').click();
    expect(h.jumps).toEqual(['new1', 'new2']);
  });

  it('a new thread that sits in view stops being new after the dwell; a flick past does not', () => {
    vi.useFakeTimers();
    const h = harness([thread('new1', [comment('x')]), thread('new2', [comment('y')])], {
      new1: 100,
      new2: 900,
    });
    expect(h.pill('bottom').dataset.fresh).toBe('1');
    // Not yet — the dwell has not elapsed.
    expect(h.seen).toEqual([]);
    vi.advanceTimersByTime(60);
    expect(h.seen).toEqual(['new1']);
    // `new2` never entered the viewport, so it is still new.
    expect(h.pill('bottom').dataset.fresh).toBe('1');
  });

  it('a card in view counts as seen even when its sentence scrolled off (the phone)', () => {
    vi.useFakeTimers();
    const card = document.createElement('div');
    card.getBoundingClientRect = () => ({ top: 40, bottom: 200, height: 160 }) as DOMRect;
    const h = harness(
      [thread('new1', [comment('x')])],
      { new1: -300 },
      { cards: { new1: [card] } },
    );
    // The COUNT still says the sentence is above…
    expect(h.pill('top').dataset.fresh).toBe('1');
    vi.advanceTimersByTime(60);
    // …but the reader has been looking at the card, so it is seen.
    expect(h.seen).toEqual(['new1']);
    expect(h.pill('top').hidden).toBe(true);
  });

  it('the bottom strip clears the action dock when one is showing', () => {
    const h = harness([thread('new1', [comment('x')])], { new1: 900 }, { dock: 700 });
    const strip = h.pane.querySelector<HTMLElement>('.edge-strip-bottom');
    // 60px of dock, a 10px gap, and the dock's own 22px inset.
    expect(strip?.style.bottom).toBe('92px');
  });
});
