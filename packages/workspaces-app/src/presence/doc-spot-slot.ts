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

/** The last move made before the page's presence listened. Presence is its
 *  own chunk and joins after the doc can already scroll, so a scroll that
 *  settled first was dropped, and the person's spot stayed at the top of the
 *  doc until they scrolled again. */
let unheard: { spot: DocPlace; heading: string | undefined } | null = null;

/** The page's presence listens here for its person's moves, and the section
 *  heading on screen with each. A move made before it listened is passed on
 *  at once. */
export function onDocSpotMove(cb: (spot: DocPlace, heading: string | undefined) => void): void {
  onMove = cb;
  const move = unheard;
  unheard = null;
  if (move) cb(move.spot, move.heading);
}

/** A surface tells the page its person moved. */
export function docSpotMoved(spot: DocPlace, heading: string | undefined): void {
  if (onMove) onMove(spot, heading);
  else unheard = { spot, heading };
}

/** A spot asked for before its doc mounted: a page that loaded to show it. */
let pending: PresenceSpot | null = null;

/** Show a followed spot on the doc on screen, if it is that doc; a spot on
 *  a doc still mounting is shown when it mounts. */
export function showDocSpot(spot: PresenceSpot): void {
  if (handle && handle.docId === spot.docId) {
    pending = null;
    handle.show(spot);
  } else {
    pending = spot;
  }
}

/** The doc mounted registers itself. Answers the function that drops it. */
export function setDocSpotHandle(next: DocSpotHandle): () => void {
  handle = next;
  if (pending && pending.docId === next.docId) {
    const spot = pending;
    pending = null;
    next.show(spot);
  }
  return () => {
    if (handle === next) handle = null;
  };
}
