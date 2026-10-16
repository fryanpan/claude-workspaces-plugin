/** One tab's stroke in a `whiteboard-browser-driver.ts` run. */
export interface WhiteboardTab {
  width: number;
  height: number;
  /** Elements the stroke added on the tab that drew it. */
  drewElements: number;
  /** Elements the other tab gained from it. */
  otherTabSaw: number;
  /** Pen up to the other tab showing the stroke, measured, never asserted. */
  reachedMs: number;
  scrollBefore: [number, number];
  scrollAfter: [number, number];
  scaleBefore: number;
  scaleAfter: number;
}

/** What `whiteboard-browser-driver.ts` prints for one run. */
export interface WhiteboardRun {
  tabs: WhiteboardTab[];
  /** The shape kinds the server stored once both strokes landed. */
  storedKinds: string[];
}
