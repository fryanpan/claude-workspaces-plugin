/**
 * Keep a review's sidebar — the diff file list, the folder tree, the doc-set
 * nav — current while it is open.
 *
 * The server sends `attachments.changed` on the set's own channel whenever a
 * row in its listing moves (a file joins, leaves, is renamed, or gains or
 * loses an open thread; `packages/server/src/page-nudges.ts`). The frame names
 * nothing, so the sidebar re-reads through the same gated route that drew it.
 * This replaced a 30s poll, which showed a change up to 30s late and asked
 * every 30s whether anything had.
 *
 * Files written straight to disk reach this frame too: while this stream is
 * open the server watches the set's folder (`server/src/folder-watch.ts`).
 *
 * Two more re-reads cover what the stream cannot: the window regaining focus
 * (kept from the poll's day — it also covers a folder the server could not
 * watch: past its cap, or a root it cannot open), and the stream reopening
 * after a drop, when frames sent in the gap are gone because none is replayed.
 */
import { openBoardStream } from './board-stream.ts';

/** The frame's name, as `page-nudges.ts` sends it. */
const SET_CHANGED_EVENT = 'attachments.changed';

export function watchSetChanges(setId: string, refresh: () => void): () => void {
  // The page's one stream for this channel (`board-stream.ts`), shared with
  // any other reader of the set's channel on the page.
  const es = openBoardStream(setId);
  let dropped = false;
  const onOpen = (): void => {
    if (dropped) refresh();
    dropped = false;
  };
  const onError = (): void => {
    dropped = true;
  };
  es.addEventListener(SET_CHANGED_EVENT, refresh);
  es.addEventListener('open', onOpen);
  es.addEventListener('error', onError);
  window.addEventListener('focus', refresh);
  return () => {
    window.removeEventListener('focus', refresh);
    es.removeEventListener(SET_CHANGED_EVENT, refresh);
    es.removeEventListener('open', onOpen);
    es.removeEventListener('error', onError);
    es.close();
  };
}
