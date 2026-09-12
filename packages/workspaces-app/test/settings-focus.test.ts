import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wireBoardSettingsPanel } from '../src/board/board-settings-panel.ts';
import { mountBoardSettingsView } from '../src/board/board-settings-view.ts';
import { buildShell } from '../src/board/board-shell.ts';
import { IPAD, PHONE, type Viewport, installSheets, setViewport } from './css-harness.ts';

/**
 * Every way out of settings lands the caret on a button that is on screen.
 *
 * Settings is a full-screen page now, so leaving it is a navigation rather
 * than the dismissal of a popover: whatever had focus goes with the page, and
 * a caret left on a hidden element drops the next Tab at the top of the
 * document. There are three exits and each band draws a different pair of
 * buttons — the rail's Settings seat above 1100, the top-right gear at or
 * below it, and the board's own nav under both.
 *
 * Driven through the exits a person uses rather than by calling the focus
 * helper: the bug this covers was a helper that worked and was never reached,
 * because the back arrow it hung off is `display: none` above 1100. So each
 * case clicks or types what a reader does, through the real shell and the
 * real cascade.
 *
 * All fixtures are synthetic. The repo is public.
 */

const WS = 'w-hbl';

let cleanup = () => {};
beforeEach(() => {
  // `renderBoardShell`'s order — board.css before styles.css, settings.css
  // after, because the settings page's own chrome is in the third.
  cleanup = installSheets('board.css', 'styles.css', 'settings.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

interface Page {
  /** Open settings the way the band's own opener does. */
  open(): void;
  /** True while the page is up. */
  isOpen(): boolean;
  /** The board page the rail was last asked for. */
  navigated(): string | null;
}

/**
 * The real shell, the real settings page and the real panel wiring.
 *
 * The panel is wired because Escape is one of the three exits and it lives
 * there; its reads all answer null, which is a state the page paints fine and
 * none of these cases look at.
 */
function page(band: Viewport): Page {
  setViewport(band);
  const narrow = band.width <= 1100;
  const root = document.createElement('div');
  root.id = 'board-root';
  document.body.appendChild(root);
  buildShell(document, root, 'Harborlight relay', WS);
  const el = (id: string): HTMLElement => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`missing #${id}`);
    return found;
  };
  let open = false;
  let nav: string | null = null;
  const render = (): void => {
    el('board-settings-view').classList.toggle('hidden', !open);
  };
  const view = mountBoardSettingsView({
    document,
    narrow: () => narrow,
    onClose: () => {
      open = false;
      render();
    },
    onNav: (next) => {
      open = false;
      render();
      nav = next;
    },
  });
  wireBoardSettingsPanel({
    document,
    el,
    workspaceId: WS,
    author: { id: 'u-reader', name: 'Reader' },
    user: { id: 'u-reader', name: 'Reader' },
    fetchJson: async () => null,
    send: async () => ({ ok: true }),
    showToast: () => {},
    isOpen: () => open,
    setOpen: (next) => {
      open = next;
    },
    renderSettingsPanel: render,
    onOpen: () => view.open(),
    href: () => `/workspaces/${WS}`,
  });
  render();
  return {
    open: () =>
      el(narrow ? 'board-settings' : 'board-nav-settings').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    isOpen: () => open,
    navigated: () => nav,
  };
}

const click = (selector: string): void => {
  const target = document.querySelector(selector);
  if (!target) throw new Error(`missing ${selector}`);
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

describe('every way out of settings lands on a visible button', () => {
  it('the rail’s Home seat above 1100 lands on Home in the board’s nav', () => {
    const p = page(IPAD);
    p.open();
    expect(p.isOpen()).toBe(true);
    // The exit the reviewer walked: at 1180 there is no back arrow, so the
    // rail is the way out, and it used to leave the caret on BODY.
    click('#board-settings-view .settings-rail-item[data-nav="home"]');
    expect(p.isOpen()).toBe(false);
    expect(p.navigated()).toBe('home');
    expect(document.activeElement).toBe(document.querySelector('#board-nav [data-nav="home"]'));
  });

  it('Escape above 1100 lands on the rail’s settings seat', () => {
    const p = page(IPAD);
    p.open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(p.isOpen()).toBe(false);
    expect(document.activeElement?.id).toBe('board-nav-settings');
  });

  it('the back arrow on the phone lands on the top-right gear', () => {
    const p = page(PHONE);
    p.open();
    // The phone opens on the list of types, from which back is the board.
    click('#board-settings-back');
    expect(p.isOpen()).toBe(false);
    expect(document.activeElement?.id).toBe('board-settings');
  });

  it('positive control: each band hides the opener the other one uses', () => {
    // Without this the cases above could be reading the first candidate in
    // the list rather than the drawn one, and only the phone case would
    // stand between this file and a vacuous pass.
    page(IPAD);
    const seat = document.getElementById('board-nav-settings') as HTMLElement;
    const gear = document.getElementById('board-settings') as HTMLElement;
    expect(getComputedStyle(seat).display).not.toBe('none');
    expect(getComputedStyle(gear).display).toBe('none');
    document.body.replaceChildren();
    page(PHONE);
    expect(getComputedStyle(document.getElementById('board-settings') as HTMLElement).display).toBe(
      'inline-flex',
    );
    expect(
      getComputedStyle(document.getElementById('board-nav-settings') as HTMLElement).display,
    ).toBe('none');
  });
});
