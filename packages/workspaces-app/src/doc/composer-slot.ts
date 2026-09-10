/**
 * WHERE the new-comment composer opens on a wide screen: in the balloon
 * margin, level with the words it is about, in the slot the posted comment's
 * balloon will take.
 *
 * Bryan's reason is Fitts's law (2026-09-10): the box he types into should be
 * where his eyes already are, not at the bottom of the page — and a composer
 * that opens where the balloon lands makes posting a fade rather than a jump
 * from one end of the screen to the other.
 *
 * Only where there IS a margin. `balloonMarginVisible` is the same predicate
 * the balloons themselves ask (`card-placement.ts`), so the composer follows
 * the reader's stored placement rather than a media query of its own: pick
 * cards-in-the-flow on the iPad and the composer goes back to the sheet at
 * the bottom, which is the surface those comments use.
 *
 * The narrow half of the same question is here too: with no margin the box
 * stays a sheet at the bottom, and what moves instead is the DOCUMENT —
 * `keyboardClearDelta` says how far, so the sentence being commented on sits
 * a few lines above the box rather than behind it.
 *
 * The geometry is pure functions over boxes so the clamps are checkable
 * without a browser; `marginComposerSlot` only reads the boxes and asks.
 */
import { balloonMarginVisible } from '../card-placement.ts';
import type { EditorHandle } from '../editor.ts';

/** A composer position in viewport coordinates — what `position: fixed` takes. */
export interface ComposerSlot {
  top: number;
  left: number;
  width: number;
}

export interface SlotMetrics {
  /** The margin column's box: the composer takes its full width. */
  column: { left: number; width: number };
  /** Top of the selection's first line — where the balloon would sit. */
  anchorTop: number;
  /** The band the composer has to stay inside (the scroller's visible box). */
  bounds: { top: number; bottom: number };
  /** The composer's own height, measured once it is on screen. */
  height: number;
}

/** Breathing room between the composer and either end of the visible band. */
const EDGE = 8;

/**
 * The slot, clamped into the visible band.
 *
 * The clamp is what keeps a composer opened off a selection near the bottom
 * of the window from opening half off-screen — the balloon column does the
 * same thing for a card whose anchor is at the fold. A band too short to hold
 * the composer pins it to the top rather than to a negative offset.
 */
export function composerSlot(m: SlotMetrics): ComposerSlot {
  const lowest = m.bounds.bottom - m.height - EDGE;
  const highest = m.bounds.top + EDGE;
  const top = lowest < highest ? highest : Math.max(highest, Math.min(m.anchorTop, lowest));
  return { top, left: m.column.left, width: m.column.width };
}

export interface MarginSlotOptions {
  editor: EditorHandle;
  /** The `#editor` scroller — the margin column is its second grid track. */
  editorMount: HTMLElement;
  /** The composer element itself, already visible, so it has a height. */
  composer: HTMLElement;
  /** Injected in a test; `balloonMarginVisible` in the product. */
  marginVisible?: () => boolean;
  /** Injected in a test; `window.visualViewport` in the product. */
  visualViewport?: { offsetTop: number; height: number } | null;
}

/**
 * Read the boxes and hand back the slot — or null, which means "the bottom
 * sheet", the surface every caller had before this module existed.
 *
 * Null on every uncertainty: no margin on screen, no column rendered yet, a
 * column measuring nothing, or a selection whose coordinates ProseMirror
 * declines to give. Note which question the width guard is NOT asking: the
 * column is gated on `body[data-cards="balloon"]`, not on a width, and
 * `balloonMarginVisible` stays true down to 901px — so the margin composer
 * opens across the whole 901–1100 band, where the narrow rules also match.
 * It survives that overlap because `#composer.composer--margin` out-specifies
 * them on every property the two share.
 *
 * The band is the VISUAL viewport, not the editor's layout box. On an iPad
 * the software keyboard takes the bottom of the screen without shrinking any
 * layout box, so a slot clamped to the layout box alone opens behind the
 * keyboard for any sentence below the fold — the same correction the comment
 * pill makes for itself in `positionPill`.
 */
export function marginComposerSlot(opts: MarginSlotOptions): ComposerSlot | null {
  const visible = opts.marginVisible ?? balloonMarginVisible;
  if (!visible()) return null;
  const column = opts.editorMount.querySelector<HTMLElement>('.markup-margin');
  if (!column) return null;
  const colRect = column.getBoundingClientRect();
  if (colRect.width <= 0) return null;
  try {
    const view = opts.editor.editor.view;
    const anchorTop = view.coordsAtPos(view.state.selection.from).top;
    const scroller = opts.editorMount.getBoundingClientRect();
    const vv = opts.visualViewport ?? window.visualViewport ?? null;
    const vvTop = vv?.offsetTop ?? 0;
    const vvBottom = vvTop + (vv?.height ?? window.innerHeight);
    return composerSlot({
      column: { left: colRect.left, width: colRect.width },
      anchorTop,
      bounds: {
        top: Math.max(scroller.top, vvTop),
        bottom: Math.min(scroller.bottom, vvBottom),
      },
      height: opts.composer.offsetHeight,
    });
  } catch {
    // A position ProseMirror has not rendered yet throws rather than
    // answering; the sheet is the honest fallback.
    return null;
  }
}

/** Lines of prose left between the commented text and the composer's top
 *  edge — Bryan asked for "a few lines above the comment prompt" so the
 *  sentence and what surrounds it stay readable while he types (2026-09-10). */
export const LINES_ABOVE_COMPOSER = 3;

/** Below this, the scroll costs more than the pixels it buys. */
const SCROLL_DEADBAND = 12;

export interface KeyboardClearMetrics {
  /** The selection's box, in viewport coordinates. */
  selTop: number;
  selBottom: number;
  /** Top edge of the composer sheet, keyboard inset already included. */
  composerTop: number;
  /** Top of the band the reader can see — `visualViewport.offsetTop`. */
  bandTop: number;
}

/**
 * How far to scroll the document so the commented text sits a few lines above
 * the composer.
 *
 * Positive scrolls the text UP the screen. It used to park the selection 20%
 * down the visible band, which on a phone put it as far from the box as the
 * screen allowed; the reference point is now the box itself, so the sentence
 * lands just above what the reader is typing however tall the keyboard is.
 *
 * The line height is read off the selection's LAST line rather than assumed:
 * a heading commented on needs more room than a caption. A line taller than
 * the gap is pinned to the top of the band instead — pushing it further up
 * would scroll the words being commented on off the screen entirely.
 */
export function keyboardClearDelta(m: KeyboardClearMetrics): number {
  const line = Math.max(16, m.selBottom - m.selTop);
  const desiredBottom = m.composerTop - line * LINES_ABOVE_COMPOSER;
  let delta = m.selBottom - desiredBottom;
  // Never scroll the selection's own top above the band.
  if (m.selTop - delta < m.bandTop) delta = m.selTop - m.bandTop;
  return Math.abs(delta) < SCROLL_DEADBAND ? 0 : delta;
}
