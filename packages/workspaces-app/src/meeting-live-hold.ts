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
  /** Let the stream go back to where the layout puts it, easing over `ms`.
   *  Zero is a cut, for the paths where nothing is animating anyway. */
  release(ms: number): void;
}

/** The hold over one stream element (`.lz-lines`). */
export function createStreamHold(lines: HTMLElement): StreamHold {
  let holding = false;

  const rectAt = (i: number): DOMRect | null =>
    lines.querySelectorAll('.lz-turn')[i]?.getClientRects()[0] ?? null;

  function release(ms: number): void {
    if (!holding) return;
    holding = false;
    if (ms > 0) {
      lines.classList.add('is-releasing');
      setTimeout(() => lines.classList.remove('is-releasing'), ms);
    }
    lines.style.removeProperty('--lz-hold-y');
    lines.style.removeProperty('--lz-hold-x');
  }

  return {
    rectAt,
    release,
    hold(anchor) {
      // Whatever the last split left applied is not the measurement this one
      // needs: drop it first, so `after` is the layout as it really stands.
      release(0);
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
