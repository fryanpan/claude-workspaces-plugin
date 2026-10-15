/** What `doc-offline-browser-driver.ts` prints for one run. */
export interface DocOfflineRun {
  /** The editor's text on the first, online load. */
  online: string;
  /** Whether the service worker controlled the page before the cut. */
  controlled: boolean;
  /** The editor's text after a reload with the server stopped. */
  offline: string;
  /** What the offline page's top bar named the doc. */
  labelOffline: string;
  /** Comment highlights in the offline page's prose. */
  commentsOffline: number;
  /** The save chip once the offline page has settled. */
  chipOffline: string;
  /** The file on disk while the server was down: the typed words are not in it. */
  fileWhileOffline: string;
  /** The editor's text after typing offline and reloading, still offline. */
  offlineAfterEdit: string;
  /** The file on disk once the server is back. */
  fileAfterReconnect: string;
}
