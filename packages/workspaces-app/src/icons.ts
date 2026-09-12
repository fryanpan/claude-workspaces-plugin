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

/** The opening attributes every icon shares. Split from the closing ones so a
 *  glyph reads as `<svg ${SVG} ${SVG_ENDS}>…` at the call site. */
export const SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"';
export const SVG_ENDS = 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/**
 * Hold-to-talk. A stroked capsule on a stand, not the `🎙` / `🎤` emoji the
 * three mics used until 2026-08-21 — those were the only colour glyphs in a
 * chrome drawn entirely in outlines, and they rendered in the system font
 * stack, so the one control Bryan reaches for most read as the one nobody had
 * finished.
 */
export const MIC_ICON = `<svg ${SVG} ${SVG_ENDS}><rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3.2"/><path d="M8.6 21.2h6.8"/></svg>`;

/**
 * A mic inside a speech bubble — voice FEEDBACK, on the widget's button at the
 * bottom-right of the board.
 *
 * A board carries two mics at once: the voice dock's, bottom-left, which talks
 * to the board, and this one, bottom-right, which sends feedback about the app
 * itself. Both drew `MIC_ICON`, so the only thing telling them apart was a
 * hover label — nothing at all to a finger. The bubble is the widget's own
 * mark (its comment button is one), so the pair reads as "speak" and "speak a
 * comment" rather than as one control drawn twice.
 */
export const FEEDBACK_MIC_ICON = `<svg ${SVG} ${SVG_ENDS}><path d="M5.5 3.2h13a3 3 0 0 1 3 3v7.4a3 3 0 0 1-3 3h-6.7l-4.6 3.6v-3.6H5.5a3 3 0 0 1-3-3V6.2a3 3 0 0 1 3-3z"/><rect x="10.3" y="6.4" width="3.4" height="5.2" rx="1.7"/><path d="M8.5 10.4a3.5 3.5 0 0 0 7 0"/></svg>`;

/**
 * Two people — the Board's "Record a conversation". The mic beside it starts
 * a huddle for one voice; this one says there is somebody else in the room,
 * which is the whole difference between the two buttons.
 */
export const PEOPLE_ICON = `<svg ${SVG} ${SVG_ENDS}><circle cx="9" cy="8" r="3.2"/><path d="M3.2 20a5.8 5.8 0 0 1 11.6 0"/><path d="M16.2 5.2a3.2 3.2 0 0 1 0 6.2"/><path d="M17.4 14.6A5.8 5.8 0 0 1 20.8 20"/></svg>`;

/** New task — the Board's primary action, drawn in the same vocabulary. */
export const PLUS_ICON = `<svg ${SVG} ${SVG_ENDS}><path d="M12 5v14"/><path d="M5 12h14"/></svg>`;

/**
 * A pencil — the Board's "Make a plan". Named for the outcome, not the
 * mechanism (round-4 entry mock): you leave with a plan doc, so the glyph is
 * the writing tool, not the mic that happens to be listening.
 */
export const PENCIL_ICON = `<svg ${SVG} ${SVG_ENDS}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;

/**
 * A speech bubble — the Board's "Have a meeting". Same rename: you leave
 * with notes of what was said, so the glyph is the saying.
 */
export const SPEECH_ICON = `<svg ${SVG} ${SVG_ENDS}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

/** The workspace nav's own glyphs: the four destinations of the approved
 *  mockup (home-pane-mockup-v1), the rail's collapse pair, and share and
 *  settings for the top-right cluster. Here rather than in `board-shell.ts`
 *  because two surfaces draw this vocabulary now — the board's rail and the
 *  settings page's — and a module importing the shell to reach a string
 *  would import the whole shell. */
export const NAV_ICONS = {
  home: `<svg ${SVG} ${SVG_ENDS}><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/></svg>`,
  tasks: `<svg ${SVG} ${SVG_ENDS}><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>`,
  activity: `<svg ${SVG} ${SVG_ENDS}><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>`,
  library: `<svg ${SVG} ${SVG_ENDS}><path d="M5 4.5h9l5 5V19.5H5z"/><path d="M14 4.5v5h5"/><path d="M8.5 13h7M8.5 16.5h7"/></svg>`,
  collapse: `<svg ${SVG} ${SVG_ENDS}><polyline points="14 6 8 12 14 18"/></svg>`,
  expand: `<svg ${SVG} ${SVG_ENDS}><polyline points="10 6 16 12 10 18"/></svg>`,
  share: `<svg ${SVG} ${SVG_ENDS}><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.3 10.8 7.4-4.3M8.3 13.2l7.4 4.3"/></svg>`,
  settings: `<svg ${SVG} ${SVG_ENDS}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
};
