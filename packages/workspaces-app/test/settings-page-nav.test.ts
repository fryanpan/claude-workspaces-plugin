import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountBoardSettingsView } from '../src/board/board-settings-view.ts';
import { type NavCollapseStorage, buildShell, wireNavCollapse } from '../src/board/board-shell.ts';
import { IPAD, PHONE, type Viewport, installSheets, setViewport } from './css-harness.ts';

/**
 * What the settings page says about where you are, and what it keeps from the
 * board you came from.
 *
 * Two questions, both answered by the same paint, and both were wrong in the
 * first cut (UX review of PR 947):
 *
 *  - On the phone the heading said "Settings" beside a back arrow that also
 *    said "Settings", so drilling into a pane told the reader nothing about
 *    which pane they had drilled into. The mock names the pane.
 *  - The rail sprang back open on the way in and collapsed again on the way
 *    out, because the settings page draws a rail of its own rather than the
 *    board's. Collapsing is a choice about the workspace, so it travels.
 *
 * Driven through the real shell and the real cascade: the rail's width and
 * the labels inside it are a stylesheet's answer.
 *
 * All fixtures are synthetic. The repo is public.
 */

const WS = 'w-hbl';

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('board.css', 'styles.css', 'settings.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** A board with its settings page mounted, opened the way its band opens it. */
function settings(band: Viewport, opts: { collapsed?: boolean } = {}): void {
  setViewport(band);
  const root = document.createElement('div');
  root.id = 'board-root';
  document.body.appendChild(root);
  buildShell(document, root, 'Harborlight relay', WS);
  const store = new Map<string, string>();
  if (opts.collapsed) store.set('cw-board-nav-collapsed', '1');
  const storage: NavCollapseStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
  wireNavCollapse(document, storage);
  const view = mountBoardSettingsView({
    document,
    narrow: () => band.width <= 1100,
    onClose: () => {},
    onNav: () => {},
  });
  document.getElementById('board-settings-view')?.classList.remove('hidden');
  view.open();
}

const text = (id: string): string => document.getElementById(id)?.textContent?.trim() ?? '';
const rail = (): HTMLElement => document.getElementById('board-settings-rail') as HTMLElement;
const label = (): HTMLElement =>
  document.querySelector('#board-settings-rail .settings-rail-label') as HTMLElement;

describe('what the settings page says about where you are', () => {
  it('names the pane on the phone, with the arrow naming the way back', () => {
    settings(PHONE);
    // The phone opens on the list of the three types: the arrow leaves
    // settings, and the heading is the page.
    expect(text('board-settings-back-label')).toBe('Board');
    expect(text('board-settings-title')).toBe('Settings');
    (
      document.querySelector('#board-settings-types [data-type="board"]') as HTMLElement
    ).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Drilled in: the arrow goes back to the list, and the heading is the
    // pane the reader is standing on. It said "Settings" twice before.
    expect(text('board-settings-back-label')).toBe('Settings');
    expect(text('board-settings-title')).toBe('Board');
  });

  it('keeps the heading on the page above 1100, where the subnav names the pane', () => {
    settings(IPAD);
    expect(text('board-settings-title')).toBe('Settings');
    expect(
      document.querySelector('.settings-subnav a[data-type="board"]')?.getAttribute('aria-current'),
    ).toBe('page');
    (
      document.querySelector('.settings-subnav a[data-type="notifications"]') as HTMLElement
    ).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(text('board-settings-title')).toBe('Settings');
    expect(
      document
        .querySelector('.settings-subnav a[data-type="notifications"]')
        ?.getAttribute('aria-current'),
    ).toBe('page');
  });
});

describe('what the settings page keeps from the board', () => {
  it('stays collapsed when the board’s rail was collapsed', () => {
    settings(IPAD, { collapsed: true });
    expect(document.getElementById('board-nav')?.classList.contains('board-nav--collapsed')).toBe(
      true,
    );
    expect(
      document
        .getElementById('board-settings-rail')
        ?.classList.contains('settings-rail--collapsed'),
    ).toBe(true);
    // The class is not the outcome. Both halves of the outcome are: the
    // labels go, AND the rail is the width the board's rail collapses to.
    // The width is the half a single-class rule loses, because settings.css
    // loads after board.css and sets .settings-rail's own width.
    expect(getComputedStyle(label()).display).toBe('none');
    expect(getComputedStyle(rail()).width).toBe('58px');
  });

  it('positive control: an expanded board rail draws its labels here too', () => {
    settings(IPAD);
    expect(
      document
        .getElementById('board-settings-rail')
        ?.classList.contains('settings-rail--collapsed'),
    ).toBe(false);
    expect(getComputedStyle(label()).display).not.toBe('none');
    expect(label().textContent).toBe('Home');
    expect(getComputedStyle(rail()).width).toBe('148px');
  });
});
