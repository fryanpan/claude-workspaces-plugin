/**
 * The Library's last row clears the floating buttons.
 *
 * Three of them stack in the viewport's bottom-right corner at every width —
 * the comment bubble, the mic, and the thread-list button above it — and they
 * belong to the feedback widget's shadow root, so nothing in the page's own
 * layout knows they are there. Measured in a real browser at 430x932 with a
 * seeded board: the topmost sits 762-806 down the viewport, and the list's
 * last row ran 778-822. Half of it was under a button, including its right
 * end, where the time is and where a thumb lands.
 *
 * So the page reserves a tail. The number it owes is the float block's top
 * edge — 170px above the viewport bottom, a 126px offset plus that button's
 * own 44px — minus what the board already ends above: `#board-root`'s own
 * 24px, plus the fixed nav bar on a phone. The two `env(safe-area-inset-
 * bottom)` terms cancel, one on each side, which is why neither appears.
 *
 * And 12px of daylight on top, because a reservation of exactly 170 ended the
 * last row's box ON the topmost button's top edge, with its count badge
 * (`top: -4px`) reaching into the row.
 *
 *   1180: 170 + 12 - 24 - 0  = 158px
 *    430: 170 + 12 - 24 - 58 = 100px
 *
 * happy-dom runs the cascade but no layout engine, so this reads the
 * reservation rather than the geometry it buys; the geometry is re-measured
 * in the browser on the PR. It also stops at substituting variables inside a
 * `calc()`, hence `pxSum` — the arithmetic is this test's, not a string
 * comparison against the declaration's text.
 *
 * All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

/** The top edge of the topmost floating button, above the viewport bottom. */
const FLOAT_STACK_PX = 170;
/** What `#board-root` ends its own content above, before any bar. */
const BOARD_ROOT_SLACK_PX = 24;
/** Room between the last row and that edge, clearing the button's badge. */
const DAYLIGHT_PX = 12;

/** Add up a px-only `calc()` the cascade left unevaluated. */
function pxSum(value: string): number {
  const terms = value.replace(/^calc\(|\)$/g, '').match(/[+-]?\s*\d+(?:\.\d+)?px/g);
  if (!terms) throw new Error(`not a px expression: ${value}`);
  return terms.reduce((sum, t) => sum + Number.parseFloat(t.replace(/\s+/g, '')), 0);
}

describe('the Library tail', () => {
  let off: () => void;

  beforeEach(() => {
    off = installSheets('board.css', 'styles.css');
    document.body.className = 'board-body';
    document.body.innerHTML =
      '<div id="board-root"><div id="board-library"><div class="library-page">' +
      '<div class="library-body"><div class="library-row"></div></div></div></div></div>';
  });
  afterEach(() => {
    off();
    document.body.className = '';
    document.body.innerHTML = '';
  });

  const body = () => document.querySelector('.library-body') as HTMLElement;

  it.each([
    ['a phone', PHONE, 58],
    ['a tablet', IPAD, 0],
  ])('ends the list above the floating buttons on %s', (_name, viewport, bar) => {
    setViewport(viewport);
    // The control: the bar's own height reaches the page at this width, so a
    // reservation that came out right did so because the rule applied rather
    // than because the media query missed and the numbers happened to agree.
    expect(styleOf(document.body).getPropertyValue('--board-bottom-bar')).toBe(`${bar}px`);
    expect(pxSum(styleOf(body()).paddingBottom)).toBe(
      FLOAT_STACK_PX + DAYLIGHT_PX - BOARD_ROOT_SLACK_PX - bar,
    );
  });

  it('reserves the whole block, not just the bubble nearest the corner', () => {
    setViewport(PHONE);
    const reserved = pxSum(styleOf(body()).paddingBottom) + BOARD_ROOT_SLACK_PX + 58;
    expect(reserved).toBeGreaterThanOrEqual(FLOAT_STACK_PX + DAYLIGHT_PX);
  });
});
