import {
  type Comment,
  type Thread,
  type ThreadProgress,
  type User,
  threadRenderKey,
} from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PAGE_CSS } from '../../widget/src/comment-view-css.ts';
import { ThreadPanel } from '../src/threads.ts';
import { IPAD, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * An agent's mark on a doc's comment card (`doc/thread-mark.ts`): the glyph
 * wears the same Breathing dots and once-drawn check the widget draws on an
 * app's pins, with the same motion, held still under reduced motion, and in
 * the glyph's own box so the card does not move. Read computed, against
 * `styles.css` as the doc page installs it.
 */

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const agent: User = { id: 'a1', name: 'Harborlight notes', kind: 'known', color: '#5b3f8f' };

let n = 0;
function thread(progress?: ThreadProgress['state'], status: Thread['status'] = 'open'): Thread {
  const c: Comment = { id: 'c1', author: alice, text: 'Tighten this.', ts: 1_700_000_000_000 };
  return {
    id: 't-mark',
    status,
    anchor: { kind: 'element', fingerprint: undefined as never, snippet: { text: 'the words' } },
    commentCount: 1,
    lastActivity: c.ts,
    createdBy: alice,
    comments: [c],
    ...(progress ? { progress: { state: progress, by: agent, at: c.ts + ++n } } : {}),
  };
}

let cleanup: Array<() => void> = [];
beforeEach(() => {
  setViewport(IPAD);
  cleanup.push(installSheets('styles.css', 'doc.css'));
});
afterEach(() => {
  for (const f of cleanup) f();
  cleanup = [];
});

/** A fresh panel per test, so each starts a fresh card; the clock is the
 *  page's, so each test uses its own thread id where it matters. */
function render(t: Thread): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  cleanup.push(() => container.remove());
  const panel = new ThreadPanel({
    container,
    currentUser: alice,
    onThreadClick: () => {},
    onReply: () => {},
    onResolve: () => {},
    onReopen: () => {},
    onReanchor: () => {},
  });
  // The card the margin, the drawer and the inline view all build.
  const card = panel.renderThread(t);
  container.appendChild(card);
  return card;
}
const glyphOf = (card: HTMLElement) => {
  const g = card.querySelector<HTMLElement>('.thread-glyph');
  if (!g) throw new Error('no glyph');
  return g;
};

const reducedMotion = () =>
  (window as unknown as { happyDOM: { settings: { device: { prefersReducedMotion: string } } } })
    .happyDOM.settings.device;

/** What the motion reads, so the doc can be compared with the widget. */
function motion(el: Element) {
  const s = styleOf(el);
  return {
    name: s.animationName,
    duration: s.animationDuration,
    delay: Number.parseFloat(s.animationDelay),
    timing: s.animationTimingFunction.replace(/\s/g, '').replace(/0\./g, '.'),
    count: s.animationIterationCount,
    opacity: Number.parseFloat(s.opacity),
  };
}

describe('an agent mark on a doc comment card', () => {
  it('working: three white dots breathing on a 4.5s cycle, in turn', () => {
    const glyph = glyphOf(render({ ...thread('working'), id: 't-work' }));
    const dots = [...glyph.querySelectorAll('.cw-breathe')];
    expect(dots).toHaveLength(3);
    expect(dots.map((d) => motion(d).name)).toEqual(['cw-breathe', 'cw-breathe', 'cw-breathe']);
    expect(dots.map((d) => motion(d).delay)).toEqual([0, 0.75, 1.5]);
    expect(motion(dots[0] as Element).duration).toBe('4.5s');
    expect(styleOf(glyph).borderRadius).toBe('50%');
  });

  it('moves exactly as the widget pin does', () => {
    const glyph = glyphOf(render({ ...thread('working'), id: 't-same' }));
    const ours = [...glyph.querySelectorAll('.cw-breathe')].map(motion);
    // The widget's own sheet, alone, on the widget's own markup.
    for (const f of cleanup) f();
    cleanup = [];
    const page = document.createElement('style');
    page.textContent = PAGE_CSS;
    document.head.appendChild(page);
    const pin = document.createElement('div');
    pin.innerHTML = glyph.innerHTML;
    document.body.appendChild(pin);
    cleanup.push(() => {
      page.remove();
      pin.remove();
    });
    const theirs = [...pin.querySelectorAll('.cw-breathe')].map(motion);
    expect(theirs.map((m) => m.name)).toEqual(['cw-breathe', 'cw-breathe', 'cw-breathe']);
    expect(ours).toEqual(theirs);
  });

  it('done: a check drawn once on the change this page saw', () => {
    const id = 't-done';
    render({ ...thread(), id });
    render({ ...thread('working'), id });
    const path = glyphOf(render({ ...thread('done'), id })).querySelector('path.cw-check');
    expect(path?.classList.contains('cw-draw')).toBe(true);
    const s = path ? styleOf(path) : null;
    expect(s?.animationName).toBe('cw-draw');
    expect(s?.animationDuration).toBe('0.55s');
    expect(s?.animationFillMode).toBe('forwards');
  });

  it('a card first seen done shows the check drawn, with no motion', () => {
    const path = glyphOf(render({ ...thread('done'), id: 't-was-done' })).querySelector(
      'path.cw-check',
    );
    expect(path, 'the check is there').not.toBeNull();
    expect(path?.classList.contains('cw-draw')).toBe(false);
    expect(path ? styleOf(path).strokeDashoffset : null).toBe('0');
  });

  it('holds still under reduced motion and still shows both marks', () => {
    const device = reducedMotion();
    const id = 't-still';
    render({ ...thread(), id });
    const working = glyphOf(render({ ...thread('working'), id }));
    // Control: the same dot animates before the preference changes.
    expect(motion(working.querySelector('.cw-breathe') as Element).name).toBe('cw-breathe');
    device.prefersReducedMotion = 'reduce';
    try {
      const dot = working.querySelector('.cw-breathe') as Element;
      expect(motion(dot).name).toBe('none');
      expect(motion(dot).opacity).toBe(0.85);
      const path = glyphOf(render({ ...thread('done'), id })).querySelector('path.cw-check');
      expect(path?.classList.contains('cw-draw'), 'the draw was asked for').toBe(true);
      expect(path ? styleOf(path).animationName : null).toBe('none');
      expect(path ? styleOf(path).strokeDashoffset : null).toBe('0');
    } finally {
      device.prefersReducedMotion = 'no-preference';
    }
  });

  it('keeps the glyph its size, wears no badge, and says nothing on a plain card', () => {
    const plain = glyphOf(render({ ...thread(), id: 't-plain' }));
    const marked = glyphOf(render({ ...thread('working'), id: 't-sized' }));
    expect(plain.classList.contains('thread-mark')).toBe(false);
    expect(plain.children).toHaveLength(0);
    const box = (g: HTMLElement) => {
      const s = styleOf(g);
      return [s.width, s.height, s.flexShrink, s.flexGrow];
    };
    expect(box(marked)).toEqual(box(plain));
    expect(box(plain)).toEqual(['15px', '15px', '0', '0']);
    expect(marked.title).toContain('Harborlight notes is working on this');
  });

  it('names the mark for a screen reader, and leaves a plain glyph silent', () => {
    const id = 't-named';
    const plain = glyphOf(render({ ...thread(), id }));
    expect(plain.getAttribute('aria-hidden')).toBe('true');
    expect(plain.getAttribute('aria-label')).toBeNull();
    const working = glyphOf(render({ ...thread('working'), id }));
    expect(working.getAttribute('aria-hidden')).toBeNull();
    expect(working.getAttribute('role')).toBe('img');
    expect(working.getAttribute('aria-label')).toBe('Harborlight notes is working on this');
    const done = glyphOf(render({ ...thread('done'), id }));
    expect(done.getAttribute('role')).toBe('img');
    expect(done.getAttribute('aria-label')).toBe('Harborlight notes finished this');
  });

  it('a resolved thread wears no mark', () => {
    const glyph = glyphOf(render({ ...thread('done', 'resolved'), id: 't-resolved' }));
    expect(glyph.classList.contains('thread-mark')).toBe(false);
    expect(glyph.querySelector('.cw-pg')).toBeNull();
  });

  it('a mark changes the card key, so every memoized card repaints', () => {
    const keys = [thread(), thread('working'), thread('done')].map(threadRenderKey);
    expect(new Set(keys).size).toBe(3);
  });
});
