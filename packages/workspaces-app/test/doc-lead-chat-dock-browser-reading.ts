/** What `doc-lead-chat-dock-browser-driver.ts` prints, read by
 *  `doc-lead-chat-dock-browser.test.ts`. */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One read of the doc page. */
export interface DockRead {
  /** Index of the paragraph at the top of the reader's view, under the top bar. */
  topPara: number;
  /** Where the comment cards go: `balloon` or `inline`. */
  cards: string | null;
  button: Box | null;
  /** The open panel, once its grow has finished; null while closed. */
  pane: Box | null;
  close: Box | null;
  /** The doc's text column (`#editor > .ProseMirror`). */
  column: Box | null;
  topbar: Box | null;
  /** On-screen paragraphs whose right end the panel covers. */
  covered: number;
  viewport: number;
}

export interface DocDockWidth {
  width: number;
  /** Before the panel opened, with it open, and after it closed. */
  before: DockRead;
  open: DockRead;
  after: DockRead;
}

export interface DocDockRun {
  widths: DocDockWidth[];
}
