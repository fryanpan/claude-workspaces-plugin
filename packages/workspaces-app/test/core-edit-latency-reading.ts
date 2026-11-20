/** What `core-edit-latency-browser-driver.ts` prints, and its test reads. */

/** One edit made by a raw page, as the board's doc page in Chrome saw it. */
export interface EditSeen {
  /** Doc frame carrying the edit arrived on the page's socket, ms after the edit. */
  storedMs: number;
  /** The edit's words were in the editor's text, ms after the edit. */
  screenMs: number;
}

export interface CoreEditLatencyRun {
  docBytes: number;
  docWeeks: number;
  /** The page outside the board (bar 3). */
  outside: {
    /** Its origin, which is not the board server's. */
    origin: string;
    boardOrigin: string;
    status: string;
    /** It held the named doc's last section once synced. */
    heldDoc: boolean;
    /** The core's open rooms while only that page was connected. */
    coreRoomsWhileAlone: string[];
    docId: string;
    /** Its own edit reached a raw page on the server. */
    editReachedServer: boolean;
  };
  /** The board's doc page in Chrome (bar 2). */
  edits: EditSeen[];
  /** The core's open rooms while the doc page was connected. */
  coreRoomsWithDocPage: string[];
}
