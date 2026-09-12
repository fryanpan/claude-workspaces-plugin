import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { focusSettingsOpener } from '../src/board/board-settings-view.ts';
import { buildShell } from '../src/board/board-shell.ts';
import { IPAD, PHONE, installSheets, setViewport } from './css-harness.ts';

/**
 * Leaving settings puts the caret back on a button that is on screen.
 *
 * There are two openers and each band draws one: the rail's Settings seat
 * above 1100, the top-right gear at or below it. Focusing the other one is
 * not a small miss — a hidden element takes focus and the next Tab starts
 * from the top of the document, with the page the reader just left still
 * underneath. The old single-button version could not get this wrong; the
 * band swap is what makes it a choice.
 *
 * Driven through the real cascade rather than asserted off the markup: which
 * button is drawn is a stylesheet's answer, and the helper asks the same
 * question the browser does.
 *
 * All fixtures are synthetic. The repo is public.
 */

let cleanup = () => {};
beforeEach(() => {
  // `renderBoardShell`'s order — board.css before styles.css.
  cleanup = installSheets('board.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function board(): void {
  const root = document.createElement('div');
  root.id = 'board-root';
  document.body.appendChild(root);
  buildShell(document, root, 'Demo board', 'w-Test123');
}

describe('the way out of settings lands on a visible button', () => {
  it('focuses the rail’s settings seat above 1100', () => {
    setViewport(IPAD);
    board();
    focusSettingsOpener(document);
    expect(document.activeElement?.id).toBe('board-nav-settings');
  });

  it('focuses the top-right gear at or below 1100', () => {
    setViewport(PHONE);
    board();
    focusSettingsOpener(document);
    expect(document.activeElement?.id).toBe('board-settings');
  });

  it('positive control: each band really does hide the other opener', () => {
    // Without this the two cases above could both be reading the first
    // element in the list rather than the drawn one, and the phone case
    // would be the only thing standing between this file and a vacuous pass.
    setViewport(IPAD);
    board();
    const seat = document.getElementById('board-nav-settings') as HTMLElement;
    const gear = document.getElementById('board-settings') as HTMLElement;
    expect(getComputedStyle(seat).display).not.toBe('none');
    expect(getComputedStyle(gear).display).toBe('none');
  });
});
