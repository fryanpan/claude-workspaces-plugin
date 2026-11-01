/**
 * What `comment-focus-remote-edit-driver.ts` prints, read by
 * `comment-focus-remote-edit-browser.test.ts`.
 */

/** Which comment box the reader is typing in. */
export type ComposerKind = 'new' | 'reply';

/** One reading of the page, taken once it has settled. */
export interface FocusReading {
  /** Where the caret is: the box under test, the document, or elsewhere
   *  (`body` when focus was dropped). */
  focus: 'composer' | 'doc' | 'body' | 'other';
  /** The words in the box under test, or null when there is no such box. */
  text: string | null;
  /** The box's top edge in viewport pixels, or null when it is not drawn. */
  boxTop: number | null;
  /** The document scroller's scrollTop. */
  scrollTop: number;
  /** The top of the words the comment is about, in viewport pixels. */
  anchorTop: number | null;
}

/** One agent edit, read before it, once it reached the page, and after the
 *  reader typed on. */
export interface EditStep {
  /** Where the edit landed relative to the commented words. */
  where: 'above' | 'below' | 'inside';
  before: FocusReading;
  /** The edit is on the page and the page has settled; nothing typed yet. */
  landed: FocusReading;
  /** After the next chunk of typing. */
  after: FocusReading;
  /** The words the reader had typed by the time of `after`. */
  typed: string;
}

export interface FocusScenario {
  width: number;
  height: number;
  kind: ComposerKind;
  opened: FocusReading;
  steps: EditStep[];
  /** After the last edit, once more typing went in. */
  final: FocusReading;
  /** Every word the reader typed, in order. */
  typed: string;
}

export interface FocusRun {
  scenarios: FocusScenario[];
}
