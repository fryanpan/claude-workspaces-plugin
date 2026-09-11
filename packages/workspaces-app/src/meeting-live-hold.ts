/**
 * THE SPLIT'S OWN LINE BREAK, and what holds the stream still over it.
 *
 * When a tick composes, the live zone (meeting-live-zone.ts) lifts the
 * settled turns out of the stream and into a block of their own, so their
 * height can be collapsed once the note lands. The chunk keeps its own words
 * on the pixels they were already on — that is what `lz-chunk` costing
 * nothing buys — but the stream had been continuing after the chunk's tail
 * MID LINE, and a block boundary is a line boundary, so the words still being
 * spoken are pushed to the start of a fresh line one line-height further
 * down. Measured in Chrome before this module existed: at 1180x820 the live
 * turn fell 23.25px and jumped from x=152.88 back to the left margin, and at
 * 430x932 it fell 21px from x=337.58 — on the one frame the settle promises
 * nothing moves on.
 *
 * So the stream is HELD where it was: pulled back up by the height the break
 * added, and indented on its first line by the width of the chunk's tail,
 * which puts every word back on the pixel it occupied. Where the boundary
 * already fell on a line start there is nothing to compensate and no hold is
 * applied.
 *
 * The hold is let go as part of the COLLAPSE — the one beat where the stream
 * is meant to travel — on the collapse's own duration and curve, so it eases
 * out with the space rather than snapping back at some other moment. Between
 * the split and that beat the stream does not move at all, which is the whole
 * point of pinning the slot's height first.
 *
 * The two offsets go out as custom properties, and doc.css turns them into
 * the stream's `margin-top` and `text-indent`; the release is a class, so
 * both properties ease on one declaration. Unset, both are zero and the rule
 * reads as the plain `margin: 0` a zone that never splits has always had.
 *
 * THE RESERVE. Letting the indent go can change how the stream WRAPS. At
 * 430px the words after a 323px indent run two lines; back at the margin
 * they fit on one, so the release takes a line out of the stream's box. A
 * reader watching the words has scrolled the pane to its foot, and a pane
 * at its foot cannot keep its scroll offset when its content shrinks: the
 * browser clamps it, and everything on screen steps DOWN by what was lost
 * below the line the reader is watching. Measured before this existed: 21px, one phone
 * line, at every note timing, while 1180x820 — where the words fit on one
 * line either way — showed 0.56px. So the release keeps the box as tall as
 * it was: a `min-height` the stream grows out of on its own (`trim`), so the
 * line the reader is on stays put and the space is filled by the next words
 * rather than taken away.
 */
export interface StreamHold {
  /** The first line box of the stream's `i`th turn, as the reader sees it.
   *  Null past the end of the stream, or where nothing lays anything out. */
  rectAt(i: number): DOMRect | null;
  /**
   * Put the stream back on `anchor` — where its first surviving turn sat
   * before the split — whatever the re-render has since moved it to. Call it
   * after the split's own render, before anything reads the zone's height.
   */
  hold(anchor: DOMRect | null): void;
  /**
   * The collapse's release: let the stream go back to where the layout puts
   * it, easing over `ms` (zero is a cut, for reduced motion), and keep its
   * box as tall as it was so a re-wrap cannot take a line from under the
   * reader — see THE RESERVE above.
   */
  release(ms: number): void;
  /** Put the stream back where the layout has it, now, keeping no height:
   *  a failed tick returns its words, so the box is about to grow anyway. */
  drop(): void;
  /** Give back a reserve the stream has grown past. Called after every
   *  re-render; it does nothing until the words fill the space. */
  trim(): void;
  /** Forget everything — hold and reserve both. The zone is hiding. */
  clear(): void;
}

/** The hold over one stream element (`.lz-lines`). */
export function createStreamHold(lines: HTMLElement): StreamHold {
  let holding = false;

  const rectAt = (i: number): DOMRect | null =>
    lines.querySelectorAll('.lz-turn')[i]?.getClientRects()[0] ?? null;

  /** The box height the release promised to keep, in px; NaN for none. */
  let reserve = Number.NaN;

  function unhold(): void {
    holding = false;
    lines.style.removeProperty('--lz-hold-y');
    lines.style.removeProperty('--lz-hold-x');
  }

  function release(ms: number): void {
    if (!holding) return;
    // Measured while still held, with the reserve of any earlier release in
    // force: this is the height the reader has been looking at.
    const kept = lines.getBoundingClientRect().height;
    if (kept > 0) {
      reserve = kept;
      lines.style.minHeight = `${kept}px`;
    }
    unhold();
    if (ms > 0) {
      lines.classList.add('is-releasing');
      setTimeout(() => lines.classList.remove('is-releasing'), ms);
    }
  }

  function clearReserve(): void {
    reserve = Number.NaN;
    lines.style.removeProperty('min-height');
  }

  return {
    rectAt,
    release,
    drop: unhold,
    trim() {
      // With a min-height in force scrollHeight is the larger of the two, so
      // strictly taller means the words themselves have outgrown the reserve
      // and giving it back moves nothing.
      if (!Number.isNaN(reserve) && lines.scrollHeight > reserve + 0.5) clearReserve();
    },
    clear() {
      unhold();
      clearReserve();
    },
    hold(anchor) {
      // Whatever the last split left applied is not the measurement this one
      // needs: drop it first, so `after` is the layout as it really stands.
      // The reserve stays — taking it back here would step the reader's
      // line down on the split, the frame the hold exists to keep still.
      unhold();
      if (!anchor) return;
      const after = rectAt(0);
      if (!after) return;
      const dy = anchor.top - after.top;
      if (Math.abs(dy) < 0.5) return;
      lines.style.setProperty('--lz-hold-y', `${dy}px`);
      lines.style.setProperty('--lz-hold-x', `${anchor.left - after.left}px`);
      holding = true;
    },
  };
}
