import { afterEach, describe, expect, it } from 'vitest';
import { PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * A sheet that is CLOSED must be off the bottom of the screen, keyboard or no
 * keyboard.
 *
 * Bryan, 2026-09-10: *"been having an issue when commenting of a 'Suggestions'
 * panel showing up along with the keyboard"*. The panel is real and is the
 * redline margin's `.cw-suggest-sheet` — title "Suggestion" — which was never
 * opened. Every bottom sheet here rides `--kb-bottom` so its own reply box
 * clears the keyboard, and every one slid away by `translateY(100%)`: 100% of
 * a box whose bottom edge has ALREADY been lifted by the keyboard, which
 * leaves exactly the keyboard's worth of it on screen. `.thread-view.hidden`
 * keeps `display: flex` and `opacity: 1` so the slide can animate, so there
 * was nothing else to hide it.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0).reverse()) f();
  document.documentElement.style.removeProperty('--kb-bottom');
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

/** The keyboard, as the app publishes it (`keyboard-inset.ts`). */
function keyboardUp(px: number): void {
  document.documentElement.style.setProperty('--kb-bottom', `${px}px`);
}

function sheet(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  document.body.appendChild(el);
  return el;
}

describe('a closed bottom sheet with the keyboard up', () => {
  it('slides away by its own height AND the keyboard inset', () => {
    setViewport(PHONE);
    cleanups.push(installSheets('styles.css', 'doc.css'));
    keyboardUp(380);
    const closed = styleOf(sheet('thread-view hidden')).transform;
    // The bug was exactly `translateY(100%)`: the inset has to be in here.
    expect(closed).toContain('380px');
    expect(closed).not.toBe('translateY(100%)');
  });

  it('leaves an OPEN sheet where it is — the inset is the slide-away’s alone', () => {
    setViewport(PHONE);
    cleanups.push(installSheets('styles.css', 'doc.css'));
    keyboardUp(380);
    expect(styleOf(sheet('thread-view')).transform).toBe('translateY(0)');
  });

  it('covers the suggestion sheet the reader actually saw', () => {
    setViewport(PHONE);
    cleanups.push(installSheets('styles.css', 'doc.css'));
    keyboardUp(380);
    expect(styleOf(sheet('thread-view cw-suggest-sheet hidden')).transform).toContain('380px');
  });

  it('covers the comments sheet too', () => {
    setViewport(PHONE);
    cleanups.push(installSheets('styles.css', 'doc.css'));
    keyboardUp(380);
    const pane = document.createElement('aside');
    pane.id = 'threads-pane';
    document.body.appendChild(pane);
    expect(styleOf(pane).transform).toContain('380px');
  });

  it('with no keyboard the slide-away is unchanged — the control', () => {
    setViewport(PHONE);
    cleanups.push(installSheets('styles.css', 'doc.css'));
    keyboardUp(0);
    const closed = styleOf(sheet('thread-view hidden')).transform;
    expect(closed).toContain('100%');
    expect(closed).not.toContain('380px');
  });
});
