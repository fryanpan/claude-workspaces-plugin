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
  /** The box's bottom edge. A box pinned to the bottom of the screen (the
   *  new-comment sheet at 430) grows upward as the reader's words wrap, so
   *  its top moves and this edge does not. */
  boxBottom: number | null;
  /** The bottom of the card holding the box when it sits in the margin (the
   *  new-comment box, or a reply's balloon), else null. */
  holderBottom: number | null;
  /** The bottom of the band the reader can see: the doc pane's bottom edge,
   *  or the visual viewport's when that is higher. */
  bandBottom: number;
  /** The document scroller's scrollTop. */
  scrollTop: number;
  /** The top of the words the comment is about, in viewport pixels. */
  anchorTop: number | null;
}

/** One agent edit, read before it, once it reached the page, and after the
 *  reader typed on. */
export interface EditStep {
  /** Where the edit landed relative to the commented words: `between` is a
   *  paragraph lengthened between the top of the screen and them, and
   *  `burst` is four edits fired inside a second while the reader types. */
  where: 'above' | 'below' | 'inside' | 'between' | 'burst';
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
