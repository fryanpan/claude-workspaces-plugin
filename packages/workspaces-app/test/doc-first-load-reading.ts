/** One page load, as `doc-first-load-browser-driver.ts` measures it. */
export interface DocLoad {
  /** ms from navigation start to the doc's text being in the page. */
  textMs: number;
  /** Bytes the page had transferred by then: the shell plus every resource. */
  bytesBeforeText: number;
  /** ms from navigation start to the editor being mounted on that text. */
  editorMs: number;
  /** ms from navigation start to the first request for the editor's chunk,
   *  or null when the page never asked for it. */
  editorChunkRequestedMs: number | null;
}

/** What the driver prints. */
export interface DocFirstLoadRun {
  /** The relay's measured rate on an uncompressed asset, bits per second. */
  relayBitsPerSecond: number;
  /** The rate the relay was set to. */
  configuredBitsPerSecond: number;
  /** Cold cache, through the relay, with the CPU slowed four times. */
  throttled: DocLoad;
  /** Cold cache, straight to the server, at full CPU. */
  unthrottled: DocLoad;
}
