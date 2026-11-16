/**
 * What `doc-round-buttons-browser-driver.ts` reads off the page, shared with
 * the test that judges it.
 *
 * audit: no-text — types only.
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** One corner button as drawn, and whether the page's hit test lands on it. */
export interface ButtonRead {
  rect: Rect;
  onTop: boolean;
}

/** The doc page at one size. */
export interface ButtonsView {
  width: number;
  height: number;
  /** The `?thread=` thread drew as the open one. */
  threadOpen: boolean;
  /** The app's own page rendered inside its frame. */
  frameRendered: boolean;
  /** The corner as read with the app frame in view. */
  buttons: { comment: ButtonRead | null; mic: ButtonRead | null; vw: number; vh: number };
  /** The doc's last paragraph, scrolled as far down as the page goes. */
  end: Rect | null;
  /** The corner as read at that scroll. */
  buttonsAtEnd: { comment: ButtonRead | null; mic: ButtonRead | null; vw: number; vh: number };
  /** The new-comment composer, open off a selection: its Post button, and
   *  the corner as read while it is open. */
  composer: {
    post: ButtonRead;
    corner: { comment: ButtonRead | null; mic: ButtonRead | null; vw: number; vh: number };
  };
  /** Addresses of child frames whose own page holds a widget. */
  framesWithWidget: string[];
}

export interface DocButtonsReading {
  views: ButtonsView[];
  /** The same doc opened with `?cw-embed=1` holds a widget element. */
  embedPageHasWidget: boolean;
}
