/** What `agent-focus-browser-driver.ts` prints, one page's view of the focus. */
export interface FocusView {
  /** The highlighted words, or null with no highlight on the page. */
  highlighted: string | null;
  /** The name on the caret at their start. */
  caret: string | null;
  /** The highlighted words are inside the editor's visible area. */
  inView: boolean;
  editorScrollTop: number;
  windowScrollY: number;
}

/** One question: what was said, where the server put its cursor, and each
 *  page's view of it once it had time to scroll there. */
export interface FocusStep {
  spoken: string;
  /** The words the server's own presence state points at. */
  serverQuote: string | null;
  /** Each page, by width. */
  views: Record<string, FocusView>;
}

export interface AgentFocusRun {
  /** Both pages' second load booted from the browser's own copy of the doc. */
  cached: boolean;
  /** Each page, by width, before the first question. */
  before: Record<string, FocusView>;
  steps: FocusStep[];
}
