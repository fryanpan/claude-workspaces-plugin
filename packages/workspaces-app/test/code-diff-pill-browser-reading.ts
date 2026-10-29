/** What `code-diff-pill-browser-driver.ts` prints. */

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** One step's reading: the pill's box (null when it is not showing) and the
 *  box of the character it belongs beside, in viewport pixels. */
export interface PillReading {
  pill: Box | null;
  text: { right: number; top: number; bottom: number };
}

/** The steps walked at one viewport width. `tap` and `longPress` are read
 *  at 430 only. */
export interface PillWidth {
  width: number;
  withinLine: PillReading;
  toLineStart: PillReading;
  click: PillReading;
  tap: PillReading | null;
  longPress: PillReading | null;
}

export interface PillRun {
  wide: PillWidth;
  phone: PillWidth;
}
