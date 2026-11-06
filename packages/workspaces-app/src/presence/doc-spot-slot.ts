/**
 * The doc on screen's half of presence, for the page's presence, which lives
 * longer than any one doc's mount. A surface registers how it reads and shows
 * a spot (`doc-spot.ts` for the markdown editor, `flat-doc-spot.ts` for code,
 * diffs and media), so `app.ts` holds no surface's code. The same shape as
 * `doc/open-thread.ts`.
 */
import type { PresenceSpot } from '@claude-workspaces/core/workspace-presence';

/** Where on the doc its person is. */
export type DocPlace = Pick<PresenceSpot, 'blockId' | 'threadId' | 'scroll'>;

export interface DocSpotHandle {
  docId: string;
  show(spot: PresenceSpot): void;
}

let handle: DocSpotHandle | null = null;
let onMove: ((spot: DocPlace, heading: string | undefined) => void) | null = null;

/** The page's presence listens here for its person's moves, and the section
 *  heading on screen with each. */
export function onDocSpotMove(cb: (spot: DocPlace, heading: string | undefined) => void): void {
  onMove = cb;
}

/** A surface tells the page its person moved. */
export function docSpotMoved(spot: DocPlace, heading: string | undefined): void {
  onMove?.(spot, heading);
}

/** Show a followed spot on the doc on screen, if it is that doc. */
export function showDocSpot(spot: PresenceSpot): void {
  if (handle && handle.docId === spot.docId) handle.show(spot);
}

/** The doc mounted registers itself. Answers the function that drops it. */
export function setDocSpotHandle(next: DocSpotHandle): () => void {
  handle = next;
  return () => {
    if (handle === next) handle = null;
  };
}
