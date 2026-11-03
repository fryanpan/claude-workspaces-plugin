/** What `lead-chat-keyboard-browser-driver.ts` prints, read by
 *  `lead-chat-keyboard-browser.test.ts`. */

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The page as the reader sees it at one moment. */
export interface KeyboardBand {
  /** The visual viewport: the part of the page not under the keyboard. */
  band: { top: number; bottom: number };
  pane: Box;
  composer: Box;
  focused: boolean;
  /** Points in the band where something other than the chat is on top. */
  misses: string[];
  missCount: number;
  navTop: number | null;
  /** How far the list is scrolled from its foot; 0 shows the newest message. */
  listGap: number;
  innerHeight: number;
}

export interface KeyboardWidthRun {
  width: number;
  /** `430`, `430-panned` (Safari moved the view down to the field), `1180`. */
  label: string;
  before: KeyboardBand;
  up: KeyboardBand;
  down: KeyboardBand;
}

export interface KeyboardRun {
  widths: KeyboardWidthRun[];
}
