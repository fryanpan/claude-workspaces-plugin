/** What `mobile-comment-tap-browser-driver.ts` prints. */

/** One reading of the page, taken after the step it names has settled. */
export interface TapView {
  /** `#editor`'s scroll offset. */
  scrollTop: number;
  /** The card under test is unfolded. */
  expanded: boolean;
  /** The card's top edge, the reply box's edges, and the band of the
   *  editor the keyboard is not covering, all in viewport pixels. */
  cardTop: number;
  replyTop: number | null;
  replyBottom: number | null;
  bandTop: number;
  bandBottom: number;
  /** How much of the window the simulated keyboard covers. */
  keyboard: number;
  /** Where the caret is: the card's reply box, the document, or neither. */
  focus: 'reply' | 'doc' | 'other';
  /** What the card's reply box holds, and how tall it is. */
  replyText: string;
  replyHeight: number | null;
  /** Pixels by which the card's showing content overruns its measured
   *  slots, which clips the foot. Zero when the card fits. */
  slotShortfall: number;
}

/** The phone page, step by step. */
export interface PhoneRun {
  /** A tap on a folded card whose top is on screen. */
  open: { before: TapView; after: TapView };
  /** A tap on the visible foot of a folded card whose top is above the editor. */
  openFromBelow: { before: TapView; after: TapView };
  /** Typing three lines' worth into the reply box the tap focused. */
  typed: TapView;
  /** The typed words reached the document itself (they must not). */
  typedIntoDoc: boolean;
  /** The reader scrolls the open card's head near the top, then taps it. */
  close: { before: TapView; after: TapView };
}

/** The wide page: a tap on a margin balloon. */
export interface WideRun {
  open: { before: TapView; after: TapView };
  close: { before: TapView; after: TapView };
}

export interface MobileCommentRun {
  phone: PhoneRun;
  wide: WideRun;
}
