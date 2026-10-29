/** The JSON `code-diff-live-edit-browser-driver.ts` prints. */
export interface ModeReading {
  /** The CodeMirror root carries `cm-file-mode`. */
  fileMode: boolean;
  /** The toolbar's Diff button is painted active. */
  diffButtonActive: boolean;
  /** The target-side lines, in order. */
  lines: string[];
  /** The text of every deleted-chunk widget, joined. */
  deleted: string;
  scrollTop: number | null;
  /** The comment pill is showing. */
  pillShown: boolean;
  /** The text of the first target-side line inside the viewport. */
  firstVisibleLine: string | null;
  /** How many "N unchanged lines" bars are drawn. */
  collapsedBars: number;
}

export interface LiveEditRun {
  before: ModeReading;
  after: ModeReading;
}
