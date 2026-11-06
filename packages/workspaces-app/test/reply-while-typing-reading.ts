/** What `reply-while-typing-driver.ts` prints and the test reads. */
export type ReplyDelivery =
  | 'same-thread'
  | 'mid-word'
  | 'other-thread'
  | 'same-thread-ask'
  | 'burst';

export interface ReplyTypingScenario {
  width: number;
  height: number;
  delivery: ReplyDelivery;
  /** What the reader typed, in order. */
  composed: string;
  boxBeforeSend: string | null;
  /** Every reply the page sent. */
  sent: string[];
  /** The reader's comments on the thread, as the server holds them. */
  posted: string[];
  /** `index:where` for each keystroke after which the box did not hold focus. */
  focusLost: string[];
  /** What held focus once the send had landed. */
  final: string;
}

export interface ReplyTypingRun {
  scenarios: ReplyTypingScenario[];
}
