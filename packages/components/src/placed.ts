/**
 * Call `fn` once the slot is in the document and laid out. Leaflet measures
 * its container when it starts, so a map started before then has no size:
 * a doc's node view is built before ProseMirror puts it in the page, and a
 * doc component's element before the page places it. A page that never lays
 * out (a test's DOM) draws once the slot is connected.
 */
export function whenPlaced(slot: HTMLElement, fn: () => void): void {
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    seen?.disconnect();
    fn();
  };
  const seen =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (slot.isConnected && slot.clientWidth > 0) go();
        });
  seen?.observe(slot);
  const tick = (n: number) => {
    if (done) return;
    if (slot.isConnected && (slot.clientWidth > 0 || n >= PLACE_FRAMES)) return go();
    if (n < GIVE_UP_FRAMES) requestAnimationFrame(() => tick(n + 1));
    else seen?.disconnect();
  };
  queueMicrotask(() => tick(0));
}

/** Frames to wait for a connected slot to get a width before drawing anyway. */
const PLACE_FRAMES = 3;
/** Frames after which a slot never connected (redrawn away) is let go. */
const GIVE_UP_FRAMES = 600;
