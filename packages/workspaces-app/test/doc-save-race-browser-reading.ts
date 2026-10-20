/** One reload inside the copy's save window, as `doc-save-race-browser-driver.ts` measured it. */
export interface SaveRaceTry {
  /** The words typed offline for this try. */
  words: string;
  /** Whether the words were on screen when the reload was sent. */
  onScreenBeforeReload: boolean;
  /** Milliseconds from sending the typing to sending the reload. */
  typedToReloadMs: number;
  /** The CPU slowdown this try typed and reloaded at. */
  cpuSlowdown: number;
  /** Whether the reload went out inside the full save's debounce. A try
   *  outside it tested nothing and was run again, slowed less. */
  inWindow: boolean;
  /** Whether the offline page after the reload showed the words. */
  shownAfterReload: boolean;
  /** Times the words appear in the doc's file while the server was down. */
  inFileWhileOffline: number;
  /** Times the words appear in the doc's file once the page reloaded online. */
  inFileAfterOnline: number;
}

/** What `doc-save-race-browser-driver.ts` prints for one run. */
export interface SaveRaceRun {
  /** The page's probe of the server while online: the control for the cut. */
  probeOnline: string;
  /** The same probe after every cut: each must read "failed". */
  probesOffline: string[];
  /** The CPU slowdown the first try started at, and keystrokes were timed at. */
  cpuSlowdown: number;
  tries: SaveRaceTry[];
  /** Round trips of one typed character at the slowed CPU, in milliseconds. */
  keystrokeMs: number[];
  /** The page's main-thread time per typed character at the slowed CPU, from
   *  Chromium's TaskDuration and ScriptDuration, the full write included. */
  mainThreadMsPerKeystroke: { task: number; script: number };
  /** Rows of appended edits kept for the doc before the identity changed, or
   *  null when the browser holds no such store. */
  appendedBeforeIdentityChange: number | null;
  /** The same count once a session answered as somebody else. */
  appendedAfterIdentityChange: number | null;
  /** Whether a copy written before the identity change was still there after it. */
  oldCopyAfterIdentityChange: boolean;
}
