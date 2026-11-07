/**
 * Where the lead chat's bar and panel sit on the page. `lead-chat-view.ts`
 * builds the elements; this measures the page and writes their positions.
 *
 * The bar is attached to the agent button. Wide (above 1100px) it runs from
 * the button's right edge along the button's own row; narrow it spans the
 * screen with 8px margins, just above the button. Either way it stops short
 * of the page's bottom-right corner, whose buttons belong to the comment
 * widget and the doc's mic and are never covered.
 *
 * The open panel docks on the right edge of a wide screen, under the board's
 * top bar, at the width `lead-chat-dock.ts` keeps. On a narrow screen it is a
 * sheet down to the board's navbar, or over the keyboard while one is up.
 */
import type { LeadChatDock } from './lead-chat-dock.ts';
import { typingBand } from './lead-chat-keyboard.ts';

/** At or under this width the page is in the mobile tier (design-mobile.md). */
export const NARROW_MAX = 1100;
/** Room kept clear at the bottom-right corner when none of its buttons can
 *  be measured. */
export const CORNER_ROOM = 72;
const BAR_H_NARROW = 50;

export interface LeadChatPlacer {
  /** Re-measure and place the bar and the panel. */
  place(): void;
  /** Hide the comment widget's corner buttons, or show them again. */
  hideWidget(hide: boolean): void;
}

export interface LeadChatPlacerOpts {
  doc: Document;
  win: Window;
  placement: 'dock' | 'float';
  button: HTMLElement;
  bar: HTMLElement;
  pane: HTMLElement;
  list: HTMLElement;
  dock: LeadChatDock;
}

export function createPlacer(opts: LeadChatPlacerOpts): LeadChatPlacer {
  const { doc, win, button, bar, pane, list, dock } = opts;

  const narrow = (): boolean => win.innerWidth <= NARROW_MAX;
  /** Where the page's foot begins: the top of the board's tab bar when it
   *  runs along the bottom, or of a floated agent button, so a sheet stops
   *  above both and the button stays in reach. */
  const footTop = (): number => {
    const vh = win.innerHeight;
    const r = doc.querySelector('.board-nav')?.getBoundingClientRect();
    const nav = r && r.height > 0 && r.top > vh / 2 ? r.top : vh;
    if (opts.placement !== 'float') return nav;
    return Math.min(nav, button.getBoundingClientRect().top - 8);
  };
  /** The left edge of the buttons already in the bottom-right corner — the
   *  comment widget's — which nothing here may cover; on one row only, when
   *  given. */
  const cornerLeft = (vw: number, vh: number, row?: { top: number; bottom: number }): number => {
    const els: Element[] = [];
    const widget = doc.querySelector('claude-feedback-widget');
    if (widget?.shadowRoot) els.push(...widget.shadowRoot.querySelectorAll('button'));
    // Unmeasured, the default room — except on a row the caller names, where
    // only a button actually on that row takes any.
    let left = row ? vw : vw - CORNER_ROOM + 12;
    const { top, bottom } = row ?? { top: vh / 2, bottom: vh };
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const onRow = r.bottom > top && r.top < bottom;
      if (r.width > 0 && r.width <= 200 && onRow && r.left > vw / 2) {
        left = Math.min(left, r.left);
      }
    }
    return left;
  };
  /** A sheet covers the screen, so the widget's corner buttons step aside
   *  while it is up rather than sit over its composer. */
  const hideWidget = (hide: boolean): void => {
    const widget = doc.querySelector<HTMLElement>('claude-feedback-widget');
    if (widget) widget.style.visibility = hide ? 'hidden' : '';
  };

  /** Where the sheet was last placed, as written (the browser rewrites
   *  `cssText`, so it cannot be read back to compare). */
  let sheetCss = '';
  const place = (): void => {
    const vw = doc.documentElement.clientWidth || win.innerWidth;
    const vh = win.innerHeight;
    const a = button.getBoundingClientRect();
    const corner = cornerLeft(vw, vh);
    if (!bar.hidden) {
      if (narrow()) {
        const foot = Math.min(a.top, footTop());
        // Across the screen, short of a corner button that rides the same row.
        const top = Math.round(foot - BAR_H_NARROW - 8);
        const right = cornerLeft(vw, vh, { top, bottom: top + BAR_H_NARROW }) - 8;
        bar.style.cssText = `left:8px;width:${Math.round(right - 8)}px;top:${top}px;height:${BAR_H_NARROW}px`;
      } else {
        const left = Math.round(a.right + 8);
        bar.style.cssText = `left:${left}px;width:${Math.max(120, Math.round(corner - 8 - left))}px;top:${Math.round(a.top)}px;height:${Math.round(a.height)}px`;
      }
    }
    const sheet = !pane.hidden && narrow();
    const docking = !pane.hidden && !sheet;
    // Read before any class below changes the list's height.
    const atFoot = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    // Both cover the corner, so the widget's buttons step aside under them.
    hideWidget(!pane.hidden);
    // Full screen pins the navbar to the bottom; measure it after it moves.
    dock.full(sheet);
    pane.classList.toggle('lc-sheet', sheet);
    pane.classList.toggle('lc-dock', docking);
    // The keyboard up: the sheet covers what is left on screen, over the navbar.
    const keys = sheet ? typingBand(win) : null;
    pane.classList.toggle('lc-keys', !!keys);
    if (sheet) {
      const css = keys
        ? `left:0;right:0;top:${keys.top}px;height:${keys.height}px`
        : `left:0;right:0;top:0;bottom:${Math.round(vh - footTop())}px`;
      // Only a sheet that changed size moves the list: a redraw under a
      // press must leave the link where the finger is.
      const moved = css !== sheetCss;
      sheetCss = css;
      pane.style.cssText = css;
      if (moved && atFoot) list.scrollTop = list.scrollHeight;
    } else if (docking) {
      // Under the board's top bar, which keeps who is here and Settings in reach.
      const topbar = doc.querySelector('.board-topbar')?.getBoundingClientRect();
      const top =
        topbar && topbar.height > 0 && topbar.bottom < vh / 3 ? Math.round(topbar.bottom) : 0;
      pane.style.cssText = `right:0;width:${dock.width(vw)}px;top:${top}px;bottom:0`;
    }
    dock.docked(docking ? dock.width(vw) : null);
  };

  return { place, hideWidget };
}
