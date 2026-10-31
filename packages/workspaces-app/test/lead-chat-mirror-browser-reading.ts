/** What `lead-chat-mirror-browser-driver.ts` prints, read by
 *  `lead-chat-mirror-browser.test.ts`. */

export interface MirrorWidthRun {
  width: number;
  /** The tool call's line, then its body once tapped. */
  tool: { head: string; open: string[]; expanded: string | null };
  /** Board-event rows shown, then after the toggle, then the toggle's count;
   *  and whether the header with its toggle stays on one row. */
  channel: { before: number; hidden: number; count: string; after: number; headerOneRow: boolean };
  /** The spoken reply's words before and after a tap. */
  voice: { closedText: boolean; label: string; words: string };
  /** A flush of the lead's text reached the open page within a second. */
  liveWithin1s: boolean;
  /** The panel's place: docked on the right, or a sheet. */
  layout: { docked: boolean; sheet: boolean; right: number; width: number; vw: number };
  /** At 1100px or narrower: where the full-screen pane and the pinned navbar
   *  sit, and whether tapping Library there closed the chat and opened it. */
  full: {
    paneTop: number;
    paneBottom: number;
    navTop: number;
    navBottom: number;
    navLeft: number;
    navWidth: number;
    vh: number;
    /** The agent button is the navbar's rightmost item. */
    agentLast: boolean;
    closedByPageTap: boolean;
    libraryCurrent: string | null;
  } | null;
  /** After dragging the docked panel's edge, and after loading the page again. */
  resized: { width: number } | null;
  afterNav: { open: boolean; width: number; docked: boolean } | null;
}

export interface MirrorRun {
  widths: MirrorWidthRun[];
}
