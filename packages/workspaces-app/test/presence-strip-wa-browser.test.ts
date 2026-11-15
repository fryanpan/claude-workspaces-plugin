/**
 * The board's presence strip on Web Awesome, in a real browser at 1180x820
 * and 430x932. `presence-strip-wa-browser-driver.ts` drives a real server
 * and the real bundles; these cases assert on its JSON.
 *
 * What a fake DOM cannot say: that the avatars paint the same 28px circles
 * in the same places as today's strip, with the same ring on the person
 * being followed, the same follow toast, and that switching the board swaps the strip on a page
 * that is already open.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { Circle, Reading, Toast, WaStripRun } from './presence-strip-wa-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'presence-strip-wa-browser-driver.ts');
const SUITE_MS = 170_000;
const SPAWN_MS = 160_000;

let run: WaStripRun | null = null;
const reading = (width: number, phase: Reading['phase']): Reading => {
  const r = run?.readings.find((x) => x.width === width && x.phase === phase);
  if (!r) throw new Error(`no ${phase} reading at ${width}`);
  return r;
};

/** What a reader sees of a circle, without which element paints it. */
const look = (c: Circle) => ({
  // The name only: the rest of the label is an age ("1s ago") that moves
  // between two readings taken seconds apart.
  name: c.label.split(' · ')[0],
  following: c.following,
  box: c.box,
  paint: c.paint,
});

describe.skipIf(CHROME === null)('the presence strip on Web Awesome, in a browser', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as WaStripRun;
  }, SUITE_MS);

  for (const width of [1180, 430]) {
    it(`draws the same people, boxes, fills and follow ring as today's at ${width}`, () => {
      const classic = reading(width, 'classic');
      const wa = reading(width, 'wa');
      // A control: the reader, Bob and the lead, with Bob followed — so two
      // equal readings are not two empty strips agreeing.
      expect(classic.circles.length).toBeGreaterThanOrEqual(3);
      expect(classic.circles.filter((c) => c.following).map((c) => c.label)).toEqual([
        expect.stringMatching(/^Bob/),
      ]);
      expect(classic.circles.every((c) => c.face === 'classic')).toBe(true);
      expect(wa.circles.every((c) => c.face === 'wa')).toBe(true);
      expect(wa.themeLinked).toBe(true);
      expect(wa.circles.map(look)).toEqual(classic.circles.map(look));
      for (const c of wa.circles) expect([c.paint.w, c.paint.h]).toEqual([28, 28]);
    }, 60_000);

    it(`draws the same circles before the Web Awesome theme has loaded, at ${width}`, () => {
      const unthemed = reading(width, 'wa-unthemed');
      expect(unthemed.circles.every((c) => c.face === 'wa')).toBe(true);
      expect(unthemed.circles.map(look)).toEqual(reading(width, 'classic').circles.map(look));
    }, 60_000);

    it(`shows the follow toast from Web Awesome, looking like today's, at ${width}`, () => {
      const classic = reading(width, 'classic').toast;
      const wa = reading(width, 'wa').toast;
      expect(classic?.face).toBe('classic');
      expect(classic?.text).toBe('Following Bob — long-press again to stop');
      expect(wa?.face).toBe('wa');
      expect(wa?.classicShown, 'one toast, not two').toBe(false);
      const {
        face: _a,
        classicShown: _b,
        chip: _c,
        onTop: _d,
        shade: _e,
        ...waLook
      } = wa ?? ({} as Toast);
      const {
        face: _f,
        classicShown: _g,
        chip: _h,
        onTop: _i,
        shade: _j,
        ...classicLook
      } = classic ?? ({} as Toast);
      expect(waLook).toEqual(classicLook);
    }, 60_000);

    it(`paints the Web Awesome toast's shadow as today's toast paints its own at ${width}`, () => {
      const classic = reading(width, 'classic').toast?.shade ?? [];
      const wa = reading(width, 'wa').toast?.shade ?? [];
      // CONTROL: the points were read, and today's toast does cast a shadow
      // there, so two equal readings are not two blank pages agreeing.
      expect(classic.length).toBeGreaterThanOrEqual(8);
      expect(wa.map((p) => p.at)).toEqual(classic.map((p) => p.at));
      expect(Math.min(...classic.map((p) => p.lum)), "a shadow under today's toast").toBeLessThan(
        245,
      );
      // Within a few levels at every point: the same page behind both, the
      // same shadow over it. A shadow cut off at the toast's width reads far
      // apart beside it and below its corners.
      for (const [i, p] of classic.entries()) {
        expect(Math.abs((wa[i]?.lum ?? -99) - p.lum), p.at).toBeLessThanOrEqual(6);
      }
    }, 60_000);

    for (const phase of ['classic', 'wa'] as const) {
      it(`keeps the ${phase === 'wa' ? 'Web Awesome' : "board's own"} toast off the widget's "≡" chip at ${width}`, () => {
        const toast = reading(width, phase).toast;
        // CONTROL: the chip is on the page, and the toast is the follow toast.
        expect(toast?.chip, 'the ≡ chip is shown').not.toBeNull();
        expect(toast?.text).toBe('Following Bob — long-press again to stop');
        const t = toast?.box ?? { x: 0, y: 0, w: 0, h: 0 };
        const c = toast?.chip ?? { x: 0, y: 0, w: 0, h: 0 };
        const w = Math.min(t.x + t.w, c.x + c.w) - Math.max(t.x, c.x);
        const h = Math.min(t.y + t.h, c.y + c.h) - Math.max(t.y, c.y);
        expect(
          w > 0 && h > 0 ? w * h : 0,
          `toast ${JSON.stringify(t)} on chip ${JSON.stringify(c)}`,
        ).toBe(0);
        expect(toast?.onTop).toBeNull();
      }, 60_000);
    }

    it(`swaps back to today's strip on the open page at ${width}`, () => {
      const again = reading(width, 'classic-again');
      expect(again.circles.every((c) => c.face === 'classic')).toBe(true);
      expect(again.circles.map(look)).toEqual(reading(width, 'classic').circles.map(look));
    }, 60_000);
  }
});
