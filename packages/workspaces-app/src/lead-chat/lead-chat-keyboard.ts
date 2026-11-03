/**
 * Where the lead chat's full-screen sheet goes while the on-screen keyboard
 * is up.
 *
 * iOS lays `position: fixed` out on the LAYOUT viewport, and `innerHeight`
 * is that viewport's height; neither shrinks when the keyboard comes up
 * (`keyboard-inset.ts`). A sheet sized from them keeps its composer at the
 * foot of the layout viewport, under the keyboard, and when Safari pans the
 * view down to the focused field the page beneath shows around the sheet.
 * The VISUAL viewport is the part still on screen, so while the keyboard is
 * up the sheet is placed on it: from its top, its height tall.
 */

/** Less shrink than this is the browser's own toolbars moving, not a
 *  keyboard. The smallest phone keyboard is well over 200px. */
const KEYBOARD_MIN = 120;

/** The part of the page the keyboard leaves visible, in the coordinates a
 *  fixed element is placed in, or null while no keyboard is up. A pinch zoom
 *  shrinks the visual viewport too, and is not a keyboard. */
export function typingBand(win: Window): { top: number; height: number } | null {
  const vv = win.visualViewport;
  if (!vv || Math.abs(vv.scale - 1) > 0.01) return null;
  if (vv.height > win.innerHeight - KEYBOARD_MIN) return null;
  return { top: Math.max(0, Math.round(vv.offsetTop)), height: Math.round(vv.height) };
}
