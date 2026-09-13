/**
 * The mic's readout, the review-item dock with the item it opens, and the
 * alert a misconfigured embed shows all stay on a phone's screen when the
 * page under them is wider than the phone, and after the reader pans.
 *
 * `widget-panel-edge.test.ts` covers the FAB, the list button, the panel and
 * the popover on the same kind of page, and says why they ran off it: a phone
 * browser lays `position: fixed` out against the page's width there. These
 * three boxes were placed the same way and were left out of that fix — the
 * readout ran 132px past a 430px screen, the dock's caret sat past its right
 * edge, and the dock's item and the alert opened below the bottom of it.
 *
 * `edge-boxes-driver.ts` measures them in headless Chromium at 1180x820,
 * 430x932 and 390x844; this file asserts on those boxes.
 *
 * audit: no-text — the driver measures a running browser; nothing here reads
 * a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import type { AlertLook, Look, Reading, Screen } from './edge-boxes-driver.ts';
import type { Box } from './panel-edge-driver.ts';

const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();

const DRIVER = join(import.meta.dirname, 'edge-boxes-driver.ts');
/** One launch, six page loads, four pans. */
const SUITE_MS = 120_000;
const SPAWN_MS = 110_000;

let readings: Reading[] = [];
const at = (width: number): Reading => {
  const r = readings.find((x) => x.width === width);
  if (!r) throw new Error(`no reading at ${width}`);
  return r;
};

/** How far a box stands outside the screen on each side, [left, top, right,
 *  bottom]; all zeros is inside. */
function outside(vv: Screen, box: Box | null, name: string): Box {
  if (!box) throw new Error(`no ${name} measured`);
  const [left, top, width, height] = vv;
  return [
    Math.max(0, left - box[0]),
    Math.max(0, top - box[1]),
    Math.max(0, box[2] - (left + width)),
    Math.max(0, box[3] - (top + height)),
  ];
}

function allOutside(look: Look, alert: AlertLook): Record<string, Box> {
  return {
    readout: outside(look.vv, look.readout, 'readout'),
    dock: outside(look.vv, look.dock, 'dock'),
    modal: outside(look.vv, look.modal, 'modal'),
    alert: outside(alert.vv, alert.alert, 'alert'),
  };
}
const INSIDE = {
  readout: [0, 0, 0, 0],
  dock: [0, 0, 0, 0],
  modal: [0, 0, 0, 0],
  alert: [0, 0, 0, 0],
};

/** Distance from a box's right side to the screen's. */
const inset = (vv: Screen, box: Box | null): number => vv[0] + vv[2] - (box as Box)[2];

describe.skipIf(CHROME === null)(
  "the widget's other fixed boxes on a page wider than the phone",
  () => {
    beforeAll(() => {
      const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
      expect(r.status, r.stderr).toBe(0);
      readings = JSON.parse(r.stdout) as Reading[];
      expect(readings.map((x) => x.width)).toEqual([1180, 430, 390]);
    }, SUITE_MS);

    for (const width of [430, 390]) {
      it(`the page really does run past a ${width}px screen, and the pans moved it`, () => {
        const r = at(width);
        for (const look of [r.still, r.alertStill]) {
          expect(look.innerWidth, 'CONTROL: the page is wider than the screen').toBeGreaterThan(
            width + 100,
          );
        }
        expect(r.panned?.vv[0], 'CONTROL: the pan moved the screen').toBeGreaterThan(100);
        expect(r.alertPanned?.vv[0], 'CONTROL: the pan moved the screen').toBeGreaterThan(100);
      });

      it(`the readout, the dock, its item and the alert sit inside a ${width}px screen`, () => {
        expect(allOutside(at(width).still, at(width).alertStill)).toEqual(INSIDE);
      });

      it(`they are still inside it after a pan across the page at ${width}`, () => {
        const r = at(width);
        expect(allOutside(r.panned as Look, r.alertPanned as AlertLook)).toEqual(INSIDE);
      });

      it(`the dock spans the screen and each box keeps its gap from the edge at ${width}`, () => {
        const r = at(width);
        for (const [look, alert] of [
          [r.still, r.alertStill],
          [r.panned as Look, r.alertPanned as AlertLook],
        ] as const) {
          const [left, , w] = look.vv;
          expect([look.dock?.[0], look.dock?.[2]]).toEqual([left, left + w]);
          expect([inset(look.vv, look.readout), inset(alert.vv, alert.alert)]).toEqual([78, 16]);
        }
      });
    }

    it('at 1180 every box stands where it always did', () => {
      const { still, alertStill } = at(1180);
      expect(still.innerWidth).toBe(1180);
      expect([still.readout?.[0], still.readout?.[2]]).toEqual([1180 - 78 - 320, 1180 - 78]);
      expect([still.dock?.[0], still.dock?.[2], still.dock?.[3]]).toEqual([0, 1180, 820]);
      expect([still.modal?.[0], still.modal?.[2], still.modal?.[3]]).toEqual([330, 850, 820]);
      const alert = alertStill.alert;
      // 320px of text plus the alert's own padding and border, which the
      // widget's box-sizing rule does not reach on this path.
      expect([alert?.[0], alert?.[2], alert?.[3]]).toEqual([1180 - 16 - 352, 1180 - 16, 820 - 16]);
    });
  },
);
