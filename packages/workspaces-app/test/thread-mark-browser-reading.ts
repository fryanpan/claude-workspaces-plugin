/** What `thread-mark-browser-driver.ts` prints, for its test to read. */

/** One page's comment card, read in the page. */
export interface MarkRead {
  /** The mark the glyph wears: `working`, `done`, or null. */
  mark: string | null;
  dots: number;
  dotAnimation: string[];
  dotOpacity: number[];
  check: boolean;
  checkAnimation: string | null;
  glyphBackground: string | null;
  /** left, top, width, height, rounded. */
  card: number[];
  glyph: number[] | null;
}

export interface MarkStep {
  /** The page showed the mark within 1s of the agent's request. */
  inTime: boolean;
  read: MarkRead | null;
}

export interface ThreadMarkRun {
  /** Keyed by width: `1180` (motion allowed) and `430` (reduced motion). */
  pages: Record<
    string,
    { before: MarkRead | null; working: MarkStep | null; done: MarkStep | null }
  >;
}
