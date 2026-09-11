/**
 * THE PAGE HOLDS STILL UNDER THE READER while an agent writes into the doc.
 *
 * A meeting doc is written to while it is being read: notes land in the prose,
 * the transcript grows at the foot, comment cards come and go in the flow. Any
 * of that changing the height of anything ABOVE the reader's line moves their
 * line down the screen; the reader's own answer to that is to scroll back, and
 * they should never have to. So this module keeps ONE line — the topmost block
 * the reader can see — on the pixel it was already on, by moving the scroll
 * offset by exactly what the layout moved it.
 *
 * WHY NOT THE BROWSER'S OWN. CSS scroll anchoring does the same job in Chrome,
 * and two things are wrong with leaving it to do it:
 *
 *  - It anchors to a node of its own choosing, not to the reader's line. With
 *    the pane parked at the foot of a live meeting doc it picked something
 *    below the words being read, so a note landing BELOW the reader's line
 *    still moved the page out from under them: measured +44px at 1180x820 and
 *    +26px at 430 on the tick, the reader's own line stepping up by the same.
 *  - Safari did not implement it until Safari 27 (mdn/browser-compat-data
 *    `css/properties/overflow-anchor.json`, "Updates for Safari 27 beta",
 *    2026-07; WebKit's `CSSScrollAnchoringEnabled` is stable on trunk). An
 *    iPad on 26.x — this product's main reading device — has none of it, and a
 *    two-line note landing above the reader pushed their text down 67px at
 *    1180 and 105px at 430.
 *
 * So the page owns the hold, on every browser, and the scroller is opted out
 * of the browser's own (`overflow-anchor: none`, written here rather than in a
 * stylesheet so the opt-out cannot outlive the module that replaces it). The
 * two never run at once, which is the only way they can never fight: a native
 * adjustment lands during layout, AFTER the frame's callbacks, so a JS repair
 * chasing it is always one painted frame late.
 *
 * WHEN IT DOES NOTHING, which is most of the time: content landing BELOW the
 * held line moves nothing above it, so there is nothing to correct. And a
 * scroll by the reader — a wheel, a drag, a `scrollIntoView` from a jump — is
 * the reader choosing a new line, so the hold re-reads which line that is
 * rather than dragging them back.
 */
import type { MountScope } from './mount-scope.ts';

export interface ReadingHold {
  /** The block whose screen position is being held, or null when the pane has
   *  nothing laid out. Exposed so a probe can name the line it measured. */
  heldBlock: () => Element | null;
  /** Re-read which line the reader is on, now. The scroll listener calls it;
   *  a caller that moves the pane without scrolling it can too. */
  repick: () => void;
}

/** Below this a correction is noise — sub-pixel layout, not a moved line. */
const EPSILON_PX = 0.5;

export function mountReadingHold(opts: { scroller: HTMLElement; scope: MountScope }): ReadingHold {
  const { scroller, scope } = opts;
  // We are the hold; the browser must not also be one. See the header.
  const priorAnchor = scroller.style.overflowAnchor;
  scroller.style.overflowAnchor = 'none';
  scope.onCleanup(() => {
    scroller.style.overflowAnchor = priorAnchor;
  });

  /** The line being held, and where on the screen it sat. */
  let ref: Element | null = null;
  let refY = 0;
  /** The offset the pane was at when that reading was taken. */
  let refScrollTop = 0;

  const paneTop = (): number => scroller.getBoundingClientRect().top;

  /**
   * The blocks a reader's eye can land on, in document order: the children of
   * each laid-out child of the scroller — the prose's paragraphs, the live
   * zone's turns. The column of comment balloons and the leader-line overlay
   * are skipped: both are positioned out of the flow, so neither moves when
   * the flow does, and holding one would hold nothing.
   */
  function* blocks(): Generator<Element> {
    for (const child of Array.from(scroller.children)) {
      const pos = getComputedStyle(child).position;
      if (pos === 'absolute' || pos === 'fixed') continue;
      const kids = child.children;
      if (kids.length === 0) {
        yield child;
        continue;
      }
      for (const block of Array.from(kids)) yield block;
    }
  }

  function repick(): void {
    const top = paneTop();
    ref = null;
    refY = 0;
    refScrollTop = scroller.scrollTop;
    for (const block of blocks()) {
      const r = block.getBoundingClientRect();
      if (r.height <= 0) continue;
      // The first block whose foot is still on screen IS the topmost one the
      // reader can see — the list is in document order, so there is no
      // earlier candidate to prefer.
      if (r.bottom <= top + 1) continue;
      ref = block;
      refY = r.top - top;
      return;
    }
  }

  /**
   * Put the held line back on its pixel.
   *
   * Called from a MutationObserver, which runs at the microtask checkpoint
   * after the script that changed the DOM and BEFORE the frame is laid out
   * and painted — so the correction is part of the same frame as the change
   * and the reader never sees the intermediate position. A `requestAnimation-
   * Frame` repair could not promise that: it runs before layout of the NEXT
   * frame, one paint too late.
   */
  function hold(): void {
    if (scope.disposed) return;
    // THE PANE IS ALREADY MOVING. A smooth `scrollIntoView` — the jump from
    // the off-screen-comments strip takes one — travels over several frames,
    // and its scroll events arrive after the mutations that expanded the card
    // it is travelling to. Correcting against a reading taken before it
    // started would write the offset mid-animation and strand the jump short
    // of its target, so a pane whose offset has moved since the last reading
    // gets a fresh one instead of a correction.
    if (scroller.scrollTop !== refScrollTop) {
      repick();
      return;
    }
    if (!ref || !ref.isConnected) {
      repick();
      return;
    }
    const r = ref.getBoundingClientRect();
    if (r.height <= 0) {
      repick();
      return;
    }
    const dy = r.top - paneTop() - refY;
    if (Math.abs(dy) < EPSILON_PX) return;
    scroller.scrollTop += dy;
    refScrollTop = scroller.scrollTop;
    // What we actually got, not what we asked for: at either end of the
    // travel the scroller clamps, and remembering the asked-for offset would
    // make the next correction chase a position that cannot exist.
    refY = ref.getBoundingClientRect().top - paneTop();
  }

  const observer = new MutationObserver(hold);
  observer.observe(scroller, { childList: true, subtree: true, characterData: true });
  scope.onCleanup(() => observer.disconnect());

  // Any scroll — the reader's wheel or drag, a jump, our own correction —
  // re-reads which line is now the top one. After a correction that reading
  // is the line we just put back, so nothing moves twice.
  scope.listen(scroller, 'scroll', repick);
  scope.listen(window, 'resize', repick);

  repick();
  return { heldBlock: () => ref, repick };
}
