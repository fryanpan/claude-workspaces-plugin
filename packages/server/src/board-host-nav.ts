/**
 * The board's four pages, for a page that carries no app bundle: a rail on the
 * left above 1100px, a bar along the foot at or under it. The mock host page
 * and the whiteboard page both draw it, because each is a page of the board
 * like any other, so the way to the board's other pages is where it is on
 * them (`BOARD_NAV_TABS` in core, which the board's own rail draws from).
 * Plain links, for the owner's pages only: a share may not hold the pages they
 * lead to. Classed `board-nav` and `board-nav-item` as well, which is how the
 * lead chat's sheet finds the bar it has to stop above and the tap it has to
 * get out of the way of.
 *
 * The nav places itself. The page beside it makes its own room, reading these
 * two sizes.
 *
 * `dock` adds the board's dock for the lead chat's agent button, where the
 * board's own nav keeps it: the foot of the rail, the left end of the bar. The
 * mock page asks for it because the button floated over its frame otherwise,
 * and at 1100px or under the frame's comment composer puts its Cancel in
 * exactly that corner, so the button covered the only way out of a comment.
 * The dock takes no room until the chat draws its button in it.
 */
import { BOARD_NAV_ICONS, BOARD_NAV_TABS, boardNavPath } from '@claude-workspaces/core/board-nav';
import { escape } from './shells.ts';

export const NAV_RAIL_W = 58;
export const NAV_BAR_H = 54;

/** The dock's rules: hidden until it holds a shown button, then at the rail's
 *  foot, or at the bar's left end, as on the board (`board.css`). */
const DOCK_STYLE =
  '.cw-host-nav>.board-nav-dock{display:flex;align-items:center;justify-content:center;flex:none}' +
  '.cw-host-nav>.board-nav-dock:not(:has(>:not([hidden]))){display:none}' +
  '@media (min-width:1101px){.cw-host-nav>.board-nav-dock{margin-top:auto;padding-top:8px;border-top:1px solid #d1d9e0}}' +
  '@media (max-width:1100px){.cw-host-nav>.board-nav-dock{order:-1;padding:0 10px;border-right:1px solid #d1d9e0}}';

export function hostNav(
  workspaceId: string,
  opts: { dock?: boolean } = {},
): { style: string; html: string } {
  const links = BOARD_NAV_TABS.map(
    (t) =>
      `<a class="board-nav-item" href="${escape(boardNavPath(workspaceId, t.nav))}" title="${t.label}">` +
      `${BOARD_NAV_ICONS[t.nav]}<span>${t.label}</span></a>`,
  ).join('');
  return {
    style:
      '.cw-host-nav{position:fixed;z-index:800;display:flex;box-sizing:border-box;background:#f6f8fa;' +
      'font:600 11px/14px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}' +
      '.cw-host-nav a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;' +
      'color:#57606a;text-decoration:none;-webkit-tap-highlight-color:transparent}' +
      '.cw-host-nav a:hover{color:#1f2328}.cw-host-nav svg{width:20px;height:20px;display:block}' +
      `@media (min-width:1101px){.cw-host-nav{top:0;left:0;bottom:0;width:${NAV_RAIL_W}px;flex-direction:column;` +
      'padding:8px 0;gap:2px;border-right:1px solid #d1d9e0}.cw-host-nav a{height:54px}}' +
      `@media (max-width:1100px){:root{--doc-dock-h:${NAV_BAR_H}px}.cw-host-nav{left:0;right:0;bottom:0;` +
      `height:calc(${NAV_BAR_H}px + env(safe-area-inset-bottom,0px));padding-bottom:env(safe-area-inset-bottom,0px);` +
      'border-top:1px solid #d1d9e0}.cw-host-nav a{flex:1}}' +
      (opts.dock ? DOCK_STYLE : ''),
    html:
      `<nav class="cw-host-nav board-nav" aria-label="Workspace pages">${links}` +
      `${opts.dock ? '<div class="board-nav-dock" role="group" aria-label="Lead chat"></div>' : ''}</nav>`,
  };
}
