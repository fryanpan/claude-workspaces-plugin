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

  /**
   * The line being held and where on the screen it sat — followed by the few
   * lines under it, as understudies.
   *
   * A tick does not only move blocks, it REPLACES them: ProseMirror rebuilds
   * the nodes a remote edit rewrote, so the very block the reader is on can
   * leave the document in the same mutation that grows something above it. A
   * hold that knew only that one block would have nothing left to measure
   * against, accept the new layout as the truth, and let the line jump by
   * whatever landed above — the fault this module exists to fix, in the case
   * where it is most likely to happen. So the reading takes the first few
   * blocks that begin on screen, and the correction rides the first of them
   * still in the document.
   */
  const held: Array<{ el: Element; y: number }> = [];
  const UNDERSTUDIES = 4;
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
    held.length = 0;
    refScrollTop = scroller.scrollTop;
    // The block the reader's eye is on is the first one that BEGINS on screen,
    // not merely the first one still showing. The difference is a long
    // paragraph or list item running up past the top of the pane: its own box
    // starts above the fold, so a rewrap of the lines up there — an edit
    // earlier in the same element — grows it downward while its `top` stays
    // exactly where it was. Holding that box would read a correction of zero
    // while the words on screen slid down it. The block after it moves by the
    // full growth, so holding THAT holds the straddler's visible tail too.
    let straddler: Element | null = null;
    for (const block of blocks()) {
      const r = block.getBoundingClientRect();
      if (r.height <= 0) continue;
      if (r.bottom <= top + 1) continue;
      if (r.top < top - 1) {
        straddler ??= block;
        continue;
      }
      held.push({ el: block, y: r.top - top });
      if (held.length >= UNDERSTUDIES) return;
    }
    if (held.length > 0) return;
    // Nothing begins on screen — one block taller than the pane fills it. Its
    // box is all there is to hold.
    if (!straddler) return;
    held.push({ el: straddler, y: straddler.getBoundingClientRect().top - top });
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
    // The reader's own line where it survived the tick, and the line under it
    // where it did not. A block the tick replaced is gone from the document
    // by the time this runs, and its understudy moved by the same growth.
    const live = held.find((h) => h.el.isConnected && h.el.getBoundingClientRect().height > 0);
    if (!live) {
      repick();
      return;
    }
    const dy = live.el.getBoundingClientRect().top - paneTop() - live.y;
    if (Math.abs(dy) < EPSILON_PX) return;
    scroller.scrollTop += dy;
    refScrollTop = scroller.scrollTop;
    // What we actually got, not what we asked for: at either end of the
    // travel the scroller clamps, and remembering the asked-for offset would
    // make the next correction chase a position that cannot exist. Every
    // understudy is re-read, not just the one that rode: a second tick before
    // the scroll listener re-picks would otherwise measure one of them
    // against a reading from before this correction.
    const top = paneTop();
    for (let i = held.length - 1; i >= 0; i--) {
      const h = held[i] as { el: Element; y: number };
      if (!h.el.isConnected) {
        held.splice(i, 1);
        continue;
      }
      h.y = h.el.getBoundingClientRect().top - top;
    }
  }

  /**
   * The other half of "something above the line changed height", and the one
   * a mutation cannot see: a block that resizes with the DOM untouched. An
   * image or an embed finishing its load, a web font swapping in, a card
   * animating open — each reflows the flow above the reader without adding,
   * removing or retyping a node, so `MutationObserver` never runs. Nothing
   * else would correct those, because the browser's own anchoring is off.
   *
   * A `ResizeObserver` is delivered after layout and before paint, so a
   * correction from here still lands in the frame that resized.
   */
  const sizes = new ResizeObserver(hold);
  /** Observed already — a live transcript retypes its last turn dozens of
   *  times a minute, and re-walking the whole doc on each of those would make
   *  the hold cost grow with the length of the meeting. */
  const watched = new WeakSet<Element>();
  function watchBlocks(): void {
    for (const block of blocks()) {
      if (watched.has(block)) continue;
      watched.add(block);
      // `border-box`: what displaces the flow is the block's outer height, and
      // the content box misses a change that is all padding — the shape a line
      // added above the fold leaves when the browser lays it out as box
      // spacing.
      sizes.observe(block, { box: 'border-box' });
    }
  }
  function forget(block: Element): void {
    sizes.unobserve(block);
    watched.delete(block);
  }
  scope.onCleanup(() => sizes.disconnect());

  const observer = new MutationObserver((records) => {
    hold();
    let structural = false;
    for (const rec of records) {
      if (rec.addedNodes.length > 0) structural = true;
      // A `ResizeObserver` holds its targets, so a block the tick replaced
      // would be kept alive by this one for as long as the doc is open.
      // Forgetting it is the other half: the editor re-inserts an element it
      // took out — a paragraph lifted into a list and put back — and a block
      // still remembered as watched while no longer observed is one the
      // resize half would never cover again.
      for (const gone of Array.from(rec.removedNodes)) {
        if (!(gone instanceof Element)) continue;
        forget(gone);
        // A removed subtree reports only its root, and the blocks are its
        // children: those went with it and are neither reported nor walked.
        for (const kid of Array.from(gone.children)) forget(kid);
      }
    }
    // Blocks the tick just wrote are new elements; they have to be watched for
    // the image that has not loaded yet. Retyped text is not — the walk only
    // happens where something was added.
    if (structural) watchBlocks();
  });
  observer.observe(scroller, { childList: true, subtree: true, characterData: true });
  scope.onCleanup(() => observer.disconnect());

  // Any scroll — the reader's wheel or drag, a jump, our own correction —
  // re-reads which line is now the top one. After a correction that reading
  // is the line we just put back, so nothing moves twice.
  scope.listen(scroller, 'scroll', repick);
  scope.listen(window, 'resize', repick);

  repick();
  watchBlocks();
  return { heldBlock: () => held[0]?.el ?? null, repick };
}
