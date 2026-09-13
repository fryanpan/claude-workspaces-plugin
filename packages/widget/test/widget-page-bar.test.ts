/**
 * A mock's own bar along the bottom of the screen can be pointed at and
 * commented on, and the widget's controls stand on top of it instead of over
 * it.
 *
 * Seen on a settings mock with a fixed tab bar: at 430 wide comment mode's
 * prompt lay across the whole bar, so every tap on a tab landed on the prompt
 * (and a tap on the last tab's right half hit Done and left the mode); at
 * 1180 the FAB sat on the last tab, where a tap left the mode too. The mockup
 * round chevrons sat on the first tab and, not being marked as the widget's,
 * took a comment themselves.
 *
 * Then seen on a mock with a left rail and no bar: at 1180 the chevrons rest
 * over the rail's last button, and marked as the widget's they swallowed a
 * tap there in comment mode, so that button could not be commented on. In
 * the mode they are looked through; out of it they step the rounds.
 *
 * `page-bar-driver.ts` drives headless Chromium at 1180x820 with a mouse and
 * 430x932 with a finger; this file asserts on what it saw.
 *
 * audit: no-text — the driver measures a running browser; nothing here reads
 * a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
// Types only: importing a value would run the driver in this process.
import type { Reading } from './page-bar-driver.ts';
import type { Box } from './panel-edge-driver.ts';

const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();

const DRIVER = join(import.meta.dirname, 'page-bar-driver.ts');
/** One launch, five page loads, about thirty taps. */
const SUITE_MS = 150_000;
const SPAWN_MS = 140_000;

let readings: Reading[] = [];
const at = (width: number): Reading => {
  const r = readings.find((x) => x.width === width);
  if (!r) throw new Error(`no reading at ${width}`);
  return r;
};
const top = (b: Box | null): number => (b as Box)[1];
const bottom = (b: Box | null): number => (b as Box)[3];
const midY = (b: Box | null): number => ((b as Box)[1] + (b as Box)[3]) / 2;

describe.skipIf(CHROME === null)("a mock's own bottom bar in comment mode", () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    readings = JSON.parse(r.stdout) as Reading[];
    expect(readings.map((x) => x.width)).toEqual([1180, 430]);
  }, SUITE_MS);

  for (const width of [1180, 430]) {
    it(`every tab takes a comment at its centre and both ends at ${width}`, () => {
      const taps = at(width).bar.taps.filter((t) => t.name !== 'chevron');
      // Three on each of four tabs, and one under each control resting over the nav.
      expect(taps).toHaveLength(4 * 3 + 2);
      for (const t of taps) {
        const tab = t.name.split(' ')[0];
        expect({ tap: t.name, composer: t.composer, about: t.about, mode: t.mode }).toEqual({
          tap: t.name,
          composer: true,
          about: `t-${tab}`,
          mode: true,
        });
      }
    });

    it(`the FAB, the list button and the chevrons stand above the bar at ${width}`, () => {
      const { nav, fab, list, chevrons } = at(width).bar;
      expect(top(nav), 'CONTROL: the nav is drawn along the bottom').toBe(at(width).height - 65);
      expect(bottom(fab)).toBeLessThanOrEqual(top(nav));
      expect(bottom(list)).toBeLessThanOrEqual(top(nav));
      expect(bottom(chevrons)).toBeLessThanOrEqual(top(nav));
    });

    it(`the mode's own way out is on top and still ends the mode at ${width}`, () => {
      const { controlOnTop, controlLeftMode } = at(width).bar;
      expect({ controlOnTop, controlLeftMode }).toEqual({
        controlOnTop: true,
        controlLeftMode: true,
      });
    });

    it(`a tap on the chevrons in comment mode does not step the round at ${width}`, () => {
      const tap = at(width).bar.taps.find((t) => t.name === 'chevron');
      expect(tap, 'CONTROL: the chevrons were drawn and tapped').toBeDefined();
      expect(tap?.mode).toBe(true);
      expect(at(width).bar.went).toEqual([]);
    });

    it(`the controls follow the bar as it goes and comes back at ${width}`, () => {
      const { bar, plain } = at(width);
      expect(bar.hidden).toEqual({ fab: plain.fab, chevrons: plain.chevrons });
      expect(midY(bar.shown.fab)).toBe(midY(bar.fab));
      expect(bar.shown.chevrons).toEqual(bar.chevrons);
    });
  }

  it('at 1180 in comment mode a tap on the chevrons comments on the page under them', () => {
    const tap = at(1180).bar.taps.find((t) => t.name === 'chevron');
    expect(tap?.composer).toBe(true);
  });

  it("at 430 in comment mode the prompt lies over the chevrons, so a tap there is the prompt's", () => {
    const { chevrons, banner, taps } = at(430).bar;
    const [l, t, r, b] = chevrons as Box;
    const [bl, bt, br, bb] = banner as Box;
    expect(l >= bl && t >= bt && r <= br && b <= bb, 'CONTROL: the prompt covers them').toBe(true);
    expect(taps.find((x) => x.name === 'chevron')?.composer).toBe(false);
  });

  it("at 1180 in comment mode a rail's last button under the chevrons takes the comment", () => {
    const rail = at(1180).rail;
    if (!rail) throw new Error('no rail reading');
    expect(rail.talk, 'CONTROL: the button rests where it did on the mock').toEqual([
      22, 748, 66, 792,
    ]);
    expect(rail.chevrons).toEqual([16, 756, 110, 804]);
    expect(rail.covered, 'CONTROL: out of the mode the chevrons cover it').toBe(true);
    expect([rail.tap.composer, rail.tap.about, rail.tap.mode]).toEqual([true, 'rail-talk', true]);
  });

  it('at 1180 out of comment mode a chevron tap still steps back a round', () => {
    const rail = at(1180).rail;
    if (!rail) throw new Error('no rail reading');
    expect({ went: rail.went, mode: rail.mode, composer: rail.composer }).toEqual({
      went: [1],
      mode: false,
      composer: false,
    });
  });

  it('at 430 the prompt sits on the bar, edge to edge', () => {
    const { nav, banner, done } = at(430).bar;
    expect([banner?.[0], banner?.[2], bottom(banner)]).toEqual([0, 430, top(nav)]);
    expect(bottom(done)).toBeLessThanOrEqual(top(nav));
  });

  it('on a page with no bar nothing moves', () => {
    const big = at(1180).plain;
    expect([big.fab, big.list, big.chevrons, bottom(big.banner)]).toEqual([
      [1114, 754, 1162, 802],
      [1116, 702, 1160, 746],
      [16, 756, 110, 804],
      72,
    ]);
    const phone = at(430).plain;
    expect([phone.fab, phone.list, phone.chevrons, phone.banner]).toEqual([
      [364, 866, 412, 914],
      [366, 814, 410, 858],
      [16, 868, 110, 916],
      [0, 867, 430, 932],
    ]);
  });

  it('at 430 the prompt spans the screen on a page wider than it, after a pan', () => {
    const wide = at(430).wide;
    if (!wide) throw new Error('no wide reading');
    expect(wide.innerWidth, 'CONTROL: the page is wider than the screen').toBeGreaterThan(530);
    expect(wide.vv[0], 'CONTROL: the pan moved the screen').toBeGreaterThan(100);
    const [left, , w, h] = wide.vv;
    expect([wide.banner?.[0], wide.banner?.[2], bottom(wide.banner)]).toEqual([left, left + w, h]);
  });
});
