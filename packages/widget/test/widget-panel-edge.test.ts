/**
 * The Feedback panel and a thread popover stay on a phone's screen when the
 * page under them is wider than the phone.
 *
 * Seen on the checkout mock at 430 wide: its top bar does not wrap, the page
 * runs past the screen's right edge, and the panel opened with its right side
 * cut off — thread text and the comment button with it. A mobile browser lays
 * `position: fixed` out against the page's width there, not the screen's, so
 * `right: 16px` measured from the far edge of the page. The popover clamped
 * to `window.innerWidth`, which reports the same page width.
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
import type { Box, Reading } from './panel-edge-driver.ts';

const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();

const DRIVER = join(import.meta.dirname, 'panel-edge-driver.ts');
/** One launch, three page loads. */
const SUITE_MS = 120_000;
const SPAWN_MS = 110_000;

let readings: Reading[] = [];
const at = (width: number): Reading => {
  const r = readings.find((x) => x.width === width);
  if (!r) throw new Error(`no reading at ${width}`);
  return r;
};

/** How far a box stands outside the screen, left and right; [0, 0] is inside. */
function outside(box: Box | null, r: Reading): [number, number] {
  if (!box) throw new Error(`nothing measured at ${r.width}`);
  const [left, width] = r.vv;
  return [Math.max(0, left - box[0]), Math.max(0, box[2] - (left + width))];
}

describe.skipIf(CHROME === null)('the panel on a page wider than the phone', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    readings = JSON.parse(r.stdout) as Reading[];
    expect(readings.map((x) => x.width)).toEqual([1180, 430, 390]);
  }, SUITE_MS);

  for (const width of [430, 390]) {
    it(`the page really does run past a ${width}px screen`, () => {
      // The control: on a page that fits, the old placement was already right.
      expect(at(width).innerWidth).toBeGreaterThan(width + 100);
    });

    it(`the open panel sits inside a ${width}px screen, 16px in from its edge`, () => {
      const r = at(width);
      expect(outside(r.panel, r)).toEqual([0, 0]);
      expect(r.vv[1] - (r.panel as Box)[2]).toBe(16);
    });

    it(`a popover from a row or a pin sits inside a ${width}px screen`, () => {
      const r = at(width);
      expect(outside(r.fromRow, r)).toEqual([0, 0]);
      expect(outside(r.fromPin, r)).toEqual([0, 0]);
    });
  }

  it('at 1180 the panel and popover stand where they always did', () => {
    const r = at(1180);
    expect(r.innerWidth).toBe(1180);
    expect(r.panel?.[0]).toBe(1180 - 16 - 340);
    expect(r.panel?.[2]).toBe(1180 - 16);
    expect(r.fromPin?.[0]).toBe(1180 - 340);
    expect(r.fromRow?.[0]).toBe(1180 - 340);
  });
});
