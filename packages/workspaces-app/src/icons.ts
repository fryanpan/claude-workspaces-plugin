/**
 * The chrome's icon vocabulary: 24×24, no fill, `currentColor` stroke, round
 * ends. Every glyph in the nav rail and the top-right cluster is drawn this
 * way, so anything that sits beside them has to be drawn this way too.
 *
 * The mic lives here rather than in `board/board-app.ts` with the nav glyphs
 * because more than one surface mounts a mic — the board's docked one and the
 * capture composer's — and importing `board-app.ts` from outside the board to
 * reach a string would pull the whole board into the doc bundle. (The review
 * doc's own hold-to-talk dock retired with the top-bar overhaul; recording
 * lives behind the Record Audio button now.)
 */

import { BOARD_NAV_ICONS } from '@claude-workspaces/core/board-nav';

/** The opening attributes every icon shares. Split from the closing ones so a
 *  glyph reads as `<svg ${SVG} ${SVG_ENDS}>…` at the call site. */
export const SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"';
export const SVG_ENDS = 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/**
 * A mic inside a speech bubble — voice FEEDBACK, on the widget's button at the
 * bottom-right of the board.
 *
 * The bubble is the widget's own mark (its comment button is one), so the
 * button reads as "speak a comment".
 */
export const FEEDBACK_MIC_ICON = `<svg ${SVG} ${SVG_ENDS}><path d="M5.5 3.2h13a3 3 0 0 1 3 3v7.4a3 3 0 0 1-3 3h-6.7l-4.6 3.6v-3.6H5.5a3 3 0 0 1-3-3V6.2a3 3 0 0 1 3-3z"/><rect x="10.3" y="6.4" width="3.4" height="5.2" rx="1.7"/><path d="M8.5 10.4a3.5 3.5 0 0 0 7 0"/></svg>`;

/** New task — the Board's primary action, drawn in the same vocabulary. */
export const PLUS_ICON = `<svg ${SVG} ${SVG_ENDS}><path d="M12 5v14"/><path d="M5 12h14"/></svg>`;

/**
 * A pencil — the Board's "Make a plan". Named for the outcome, not the
 * mechanism (round-4 entry mock): you leave with a plan doc, so the glyph is
 * the writing tool, not the mic that happens to be listening.
 */
export const PENCIL_ICON = `<svg ${SVG} ${SVG_ENDS}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;

/** The workspace nav's own glyphs: the four destinations of the approved
 *  mockup (home-pane-mockup-v1), the rail's collapse pair, and share and
 *  settings for the top-right cluster. Here rather than in `board-shell.ts`
 *  because two surfaces draw this vocabulary now — the board's rail and the
 *  settings page's — and a module importing the shell to reach a string
 *  would import the whole shell. */
export const NAV_ICONS = {
  home: BOARD_NAV_ICONS.home,
  tasks: BOARD_NAV_ICONS.tasks,
  activity: BOARD_NAV_ICONS.activity,
  library: BOARD_NAV_ICONS.library,
  collapse: `<svg ${SVG} ${SVG_ENDS}><polyline points="14 6 8 12 14 18"/></svg>`,
  expand: `<svg ${SVG} ${SVG_ENDS}><polyline points="10 6 16 12 10 18"/></svg>`,
  share: `<svg ${SVG} ${SVG_ENDS}><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.3 10.8 7.4-4.3M8.3 13.2l7.4 4.3"/></svg>`,
  settings: `<svg ${SVG} ${SVG_ENDS}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
};
