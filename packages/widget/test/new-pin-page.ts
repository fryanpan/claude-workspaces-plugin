/**
 * What `new-pin-driver.ts` and `new-pin.test.ts` share: the elements the
 * reader comments on, the shape of what the driver measured, and the one
 * judgement both make of a pin. Every value comes from the running page.
 */
// audit: no-text

/** [left, top, right, bottom], rounded, in the frame's own coordinates. */
export type Box = [number, number, number, number];

/** Each element commented on: an expression for it in the frame. */
export const TARGETS = {
  heading: `document.querySelectorAll('main h3')[1]`,
  para: `document.getElementById('lede')`,
  label: `document.querySelector('#chart text')`,
  cell: `document.querySelectorAll('.grid .mi')[2]`,
} as const;
export type Target = keyof typeof TARGETS;

export interface After {
  /** The thread reached the server. */
  posted: boolean;
  /** The frame's copy of the doc holds it. */
  inFrame: boolean;
  /** Its pin: its drop drawn, and where its tip is. Null with no pin at all. */
  pin: { drawn: boolean; tip: [number, number] } | null;
  /** The element's box. */
  el: Box | null;
}

export interface Reading {
  /** `<width>` for the round the page loaded with, `<width>-swapped` for the
   *  round swapped in after it; each maps a target to what the frame showed
   *  after the comment on it was posted. */
  runs: Record<string, Record<Target, After>>;
  /** The second round reached the open page without a reload. */
  swapped: Record<string, boolean>;
}

/** A pin's tip is on its element: within a pin's reach of the box. */
export function onElement(a: After): boolean {
  if (!a.pin?.drawn || !a.el) return false;
  const [x, y] = a.pin.tip;
  const [l, t, r, b] = a.el;
  return x >= l - 40 && x <= r + 40 && y >= t - 40 && y <= b + 40;
}
