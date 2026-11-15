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

    it(`shows the follow toast from Web Awesome, looking like today's, at ${width}`, () => {
      const classic = reading(width, 'classic').toast;
      const wa = reading(width, 'wa').toast;
      expect(classic?.face).toBe('classic');
      expect(classic?.text).toBe('Following Bob — long-press again to stop');
      expect(wa?.face).toBe('wa');
      expect(wa?.classicShown, 'one toast, not two').toBe(false);
      const { face: _a, classicShown: _b, ...waLook } = wa ?? ({} as Toast);
      const { face: _c, classicShown: _d, ...classicLook } = classic ?? ({} as Toast);
      expect(waLook).toEqual(classicLook);
    }, 60_000);

    it(`swaps back to today's strip on the open page at ${width}`, () => {
      const again = reading(width, 'classic-again');
      expect(again.circles.every((c) => c.face === 'classic')).toBe(true);
      expect(again.circles.map(look)).toEqual(reading(width, 'classic').circles.map(look));
    }, 60_000);
  }
});
