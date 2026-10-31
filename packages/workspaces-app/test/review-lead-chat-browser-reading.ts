/** What `review-lead-chat-browser-driver.ts` prints, read by
 *  `review-lead-chat-browser.test.ts`. */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ReviewLeadChatWidthRun {
  width: number;
  /** The board the first card is from, and the lead the chat named. */
  firstProject: string;
  firstLead: string | null;
  /** The agent button sits in the review page's rail dock. */
  inDock: boolean;
  /** The button with the chat closed, then open. */
  buttonClosed: Box | null;
  buttonOpen: Box | null;
  /** The same board's own page, at the same size: where its button sits. */
  boardButton: Box | null;
  /** A text flush from the first card's lead reached the open chat in 1s. */
  liveWithin1s: boolean;
  /** A flush from the OTHER board's lead never showed in this chat. */
  otherLeadShown: boolean;
  /** After Skip, the second card's board and the lead the chat named. */
  secondProject: string;
  secondLead: string | null;
  /** The button after Skip, chat closed. */
  buttonAfterSkip: Box | null;
}

export interface ReviewLeadChatRun {
  widths: ReviewLeadChatWidthRun[];
  /** Board name → its lead's display name, as the fixtures set them. */
  leads: Record<string, string>;
}
