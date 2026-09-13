/**
 * The widget's own fixed controls stay on a phone's screen when the page
 * under them is wider than the phone, and after the reader pans across it.
 *
 * Seen on the checkout mock at 430 wide: its top bar does not wrap, the page
 * runs past the screen's right edge, and the Feedback panel opened with its
 * right side cut off — thread text and the comment button with it — while
 * the FAB and the list button were not on screen at all. A mobile browser
 * lays `position: fixed` out against the page's width there, not the
 * screen's, so a right offset measured from the far edge of the page. The
 * popover clamped to `window.innerWidth`, which reports the same page width.
 *
 * `panel-edge-driver.ts` loads the widget into headless Chromium at 1180x820,
 * 430x932 and 390x844 on a page shaped like that mock, and this file asserts
 * on the boxes it measured.
 *
 * audit: no-text — the driver measures a running browser; nothing here reads
 * a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import type { Box, Look, Reading } from './panel-edge-driver.ts';

const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();

const DRIVER = join(import.meta.dirname, 'panel-edge-driver.ts');
/** One launch, three page loads, two pans. */
const SUITE_MS = 120_000;
const SPAWN_MS = 110_000;

let readings: Reading[] = [];
const at = (width: number): Reading => {
  const r = readings.find((x) => x.width === width);
  if (!r) throw new Error(`no reading at ${width}`);
  return r;
};

const CONTROLS = ['fab', 'list', 'panel', 'fromRow', 'fromPin'] as const;

/** For each control, how far it stands outside the screen, left and right;
 *  [0, 0] is inside. */
function outside(look: Look): Record<string, [number, number]> {
  const [left, width] = look.vv;
  const out: Record<string, [number, number]> = {};
  for (const name of CONTROLS) {
    const box = look[name];
    if (!box) throw new Error(`no ${name} measured`);
    out[name] = [Math.max(0, left - box[0]), Math.max(0, box[2] - (left + width))];
  }
  return out;
}
const INSIDE = Object.fromEntries(CONTROLS.map((n) => [n, [0, 0]]));

/** Distance from a box's right side to the screen's. */
const inset = (look: Look, box: Box | null): number => look.vv[0] + look.vv[1] - (box as Box)[2];

describe.skipIf(CHROME === null)("the widget's controls on a page wider than the phone", () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    readings = JSON.parse(r.stdout) as Reading[];
    expect(readings.map((x) => x.width)).toEqual([1180, 430, 390]);
  }, SUITE_MS);

  for (const width of [430, 390]) {
    it(`the page really does run past a ${width}px screen, and the pan moved the screen`, () => {
      // The controls: on a page that fits, the old placement was already right,
      // and a pan that went nowhere would re-measure the first look.
      expect(at(width).still.innerWidth).toBeGreaterThan(width + 100);
      expect(at(width).panned?.vv[0]).toBeGreaterThan(100);
    });

    it(`the FAB, list button, panel and popovers sit inside a ${width}px screen`, () => {
      expect(outside(at(width).still)).toEqual(INSIDE);
    });

    it(`they are still inside it after a pan across the page at ${width}`, () => {
      expect(outside(at(width).panned as Look)).toEqual(INSIDE);
    });

    it(`each keeps its own gap from the screen's edge at ${width}`, () => {
      for (const look of [at(width).still, at(width).panned as Look]) {
        expect([inset(look, look.fab), inset(look, look.list), inset(look, look.panel)]).toEqual([
          18, 20, 16,
        ]);
      }
    });
  }

  it('at 1180 every control stands where it always did', () => {
    const r = at(1180).still;
    expect(r.innerWidth).toBe(1180);
    expect(r.fab?.[2]).toBe(1180 - 18);
    expect(r.list?.[2]).toBe(1180 - 20);
    expect(r.panel?.[0]).toBe(1180 - 16 - 340);
    expect(r.panel?.[2]).toBe(1180 - 16);
    expect(r.fromPin?.[0]).toBe(1180 - 340);
    expect(r.fromRow?.[0]).toBe(1180 - 340);
  });
});
