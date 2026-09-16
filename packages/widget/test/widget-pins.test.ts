/**
 * Every comment on a mock has a pin where it was put, measured in a real
 * browser with real input at 1180x820 and 430x932.
 *
 * What a reviewer found on a mock before this (2026-09-13):
 *
 * - A tap on white space anchored to the container holding that space — on a
 *   board-chrome mock, a box the size of the page — and the pin went to that
 *   box's top-right corner, under the top bar, nowhere near the tap.
 * - A thread whose element sat on a screen the mock's script had not opened
 *   drew its pin at the no-box corner, off the top left of the screen.
 * - Resolved threads drew no pin at all, so they could not be found again.
 * - On the mock of the fix, a pin stood over the word of the chip it marked
 *   ("Malformed"), and numbered pins sat beside plain ones ("Why are there
 *   both?").
 *
 * `pins-driver.ts` drives the page; this file asserts on what it measured.
 *
 * audit: no-text — the driver measures a running browser; nothing here reads
 * a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { Box, Look, Pin, Reading } from './pins-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'pins-driver.ts');
const SUITE_MS = 180_000;
const WIDTHS = [1180, 430] as const;

let readings: Reading[] = [];
const at = (width: number): Reading => {
  const r = readings.find((x) => x.width === width);
  if (!r) throw new Error(`no reading at ${width}`);
  return r;
};
const look = (width: number, name: string): Look => {
  const l = at(width).looks[name];
  if (!l) throw new Error(`no look "${name}" at ${width}`);
  return l;
};
const pin = (width: number, name: string, id: string): Pin => {
  const p = look(width, name).pins.find((x) => x.id === id);
  if (!p) throw new Error(`no pin ${id} in "${name}" at ${width}`);
  return p;
};

/** The painted drop: 20px wide, its tip at the bottom. */
const drop = (p: Pin): Box => [p.tip[0] - 10, p.tip[1] - 25, p.tip[0] + 10, p.tip[1]];

function overlap(a: Box, b: Box): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

const near = (p: Pin, b: Box | null | undefined, by: number): boolean =>
  !!b &&
  p.tip[0] >= b[0] - by &&
  p.tip[0] <= b[2] + by &&
  p.tip[1] >= b[1] - by &&
  p.tip[1] <= b[3] + by;

describe.skipIf(CHROME === null)('pins on a mock', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SUITE_MS - 10_000 });
    expect(r.status, r.stderr).toBe(0);
    readings = JSON.parse(r.stdout) as Reading[];
    expect(readings.map((x) => x.width)).toEqual([...WIDTHS]);
  }, SUITE_MS);

  describe.each(WIDTHS)('at %i', (width) => {
    it('stands a tap on white space at the tapped point, not the container’s corner', () => {
      const { taps, main, anchors, height } = at(width);
      // CONTROL: the tap really did land on a container the size of the page.
      expect(taps.space?.under).toBe('board-main');
      expect(main[2] - main[0]).toBeGreaterThanOrEqual(width * 0.9);
      expect(main[3] - main[1]).toBeGreaterThanOrEqual(height * 0.9);
      const [space] = anchors;
      expect(space?.fingerprint.id).toBe('board-main');
      // The anchor keeps where in it the tap was…
      const { x, y } = taps.space ?? { x: 0, y: 0 };
      expect(space?.at?.x).toBeCloseTo(x / (main[2] - main[0]), 2);
      expect(space?.at?.y).toBeCloseTo(y / (main[3] - main[1]), 2);
      // …and after the reload the pin's tip is there.
      const p = pin(width, 'reloaded', 't-space');
      expect(p.shown).toBe(true);
      expect(Math.abs(p.tip[0] - x)).toBeLessThanOrEqual(2);
      expect(Math.abs(p.tip[1] - y)).toBeLessThanOrEqual(2);
    });

    it('covers no page text — not the word it marks, nor a neighbour’s', () => {
      // CONTROL: the chip was tapped on its word, so a drop at that point
      // would sit on it; and the review thread's point is on the chip's word
      // too, from the button below it.
      expect(at(width).taps.chip?.under).toBe('b4-chip');
      const chip = pin(width, 'reloaded', 't-chip');
      expect(chip.shown).toBe(true);
      const chipBox = look(width, 'reloaded').el['b4-chip'];
      expect(near(chip, chipBox, 30), 'still by its chip').toBe(true);
      // Nor over the chip's pill, cutting its end off.
      expect(overlap(drop(chip), chipBox ?? [0, 0, 0, 0]), 'on the chip it marks').toBe(0);
      for (const name of ['reloaded', 'tidesShown', 'walkBuilt', 'slid']) {
        const l = look(width, name);
        expect(l.text.length, 'CONTROL: page text was measured').toBeGreaterThanOrEqual(8);
        for (const p of l.pins.filter((q) => q.shown)) {
          for (const t of l.text) {
            expect(overlap(drop(p), t), `${name}: ${p.id} over text at ${t}`).toBe(0);
          }
        }
      }
    });

    it('stands no pin on another', () => {
      const shown = look(width, 'walkBuilt').pins.filter((p) => p.shown);
      expect(shown.length, 'CONTROL: two share an element, five a heading').toBe(15);
      for (const [i, a] of shown.entries()) {
        for (const b of shown.slice(i + 1)) {
          expect(overlap(drop(a), drop(b)), `${a.id} on ${b.id}`).toBe(0);
        }
      }
    });

    it('keeps a crowded heading’s pins by its words, not out at its box’s far corner', () => {
      // Five on one heading is more than its edges hold. Each still stands
      // within about a pin of the words a reader sees (its drop is 25px tall)
      // — a heading's box runs the width of the page, and a pin by its far
      // corner reads as belonging to nothing.
      const l = look(width, 'walkBuilt');
      const title = l.el.title ?? [0, 0, 0, 0];
      expect(title[2] - l.words[2], 'CONTROL: the box runs far past the words').toBeGreaterThan(
        150,
      );
      const crowd = l.pins.filter((q) => q.shown && q.id.startsWith('t-crowd'));
      expect(crowd.length).toBe(5);
      for (const p of crowd) expect(near(p, l.words, 32), `${p.id} at ${p.tip}`).toBe(true);
    });

    it('anchors a tap on an icon to its button, and pins it after a reload', () => {
      const { taps, anchors } = at(width);
      // CONTROL: the tap landed on a shape inside the icon's drawing.
      expect(taps.icon?.under).toBe('circle');
      expect(anchors[2]?.fingerprint.tag).toBe('BUTTON');
      expect(anchors[2]?.fingerprint.id, 'CONTROL: the button has no id').toBeUndefined();
      const p = pin(width, 'reloaded', 't-icon');
      expect(p.shown).toBe(true);
      expect(near(p, look(width, 'reloaded').el['b4-icon'], 30)).toBe(true);
    });

    it('stands an icon button’s pin beside it, not over its icon', () => {
      const icon = look(width, 'reloaded').el['b4-icon'];
      // CONTROL: the thread keeps the tapped point, in the middle of the icon.
      expect(at(width).anchors[2]?.at?.x).toBeCloseTo(0.5, 1);
      expect(overlap(drop(pin(width, 'reloaded', 't-icon')), icon ?? [0, 0, 0, 0])).toBe(0);
    });

    it('pins every thread after a reload, resolved ones included', () => {
      const shown = look(width, 'reloaded')
        .pins.filter((p) => p.shown)
        .map((p) => p.id)
        .sort();
      expect(shown).toEqual([
        't-bar',
        't-chip',
        't-crowd-1',
        't-crowd-2',
        't-crowd-3',
        't-crowd-4',
        't-crowd-5',
        't-dot',
        't-icon',
        't-resolved',
        't-review',
        't-space',
        't-title',
      ]);
      expect(
        near(pin(width, 'reloaded', 't-resolved'), look(width, 'reloaded').el['b2-title'], 30),
      ).toBe(true);
    });

    it('stands a pin beside an element with no words, not at the screen’s edge', () => {
      const l = look(width, 'reloaded');
      expect(l.el['b2-dot'], 'CONTROL: the dot is on screen').not.toBeNull();
      expect((l.el['b2-dot']?.[0] ?? 0) - 16, 'CONTROL: far from the edge').toBeGreaterThan(60);
      expect(near(pin(width, 'reloaded', 't-dot'), l.el['b2-dot'], 30)).toBe(true);
    });

    it('moves a pin off the words an element slides onto, size unchanged', () => {
      const before = look(width, 'walkBuilt').el['b2-dot'];
      const after = look(width, 'slid').el['b2-dot'];
      // CONTROL: the dot moved and kept its size.
      expect((before?.[0] ?? 0) - (after?.[0] ?? 0)).toBeGreaterThan(40);
      expect(
        Math.abs((after?.[2] ?? 0) - (after?.[0] ?? 0) - ((before?.[2] ?? 0) - (before?.[0] ?? 0))),
      ).toBeLessThanOrEqual(1);
      const p = pin(width, 'slid', 't-dot');
      expect(p.shown).toBe(true);
      expect(near(p, after, 30)).toBe(true);
      for (const t of look(width, 'slid').text) {
        expect(overlap(drop(p), t), `over text at ${t}`).toBe(0);
      }
    });

    it('stands a pin on screen for an element at the top edge', () => {
      const l = look(width, 'reloaded');
      expect(l.el['bar-tag']?.[1], 'CONTROL: the tag is at the top').toBeLessThan(10);
      const p = pin(width, 'reloaded', 't-bar');
      expect(p.shown).toBe(true);
      expect(p.tip[1] - 25, `drop top at ${p.tip}`).toBeGreaterThanOrEqual(0);
      expect(near(p, l.el['bar-tag'], 30)).toBe(true);
    });

    it('holds the pin of a hidden screen’s thread until the page shows it, never off screen', () => {
      expect(look(width, 'reloaded').el['tide-high'], 'CONTROL: the screen is hidden').toBeNull();
      expect(pin(width, 'reloaded', 't-tide').shown).toBe(false);
      const shown = pin(width, 'tidesShown', 't-tide');
      expect(shown.shown).toBe(true);
      expect(near(shown, look(width, 'tidesShown').el['tide-high'], 30)).toBe(true);
      for (const name of ['reloaded', 'tidesShown', 'walkBuilt']) {
        for (const p of look(width, name).pins.filter((q) => q.shown)) {
          const [l, t, r] = drop(p);
          expect(l >= 0 && r <= width && t >= 0, `${name}: ${p.id} at ${p.tip}`).toBe(true);
        }
      }
    });

    it('pins a thread on an element the page builds later, once it is built', () => {
      expect(look(width, 'reloaded').pins.some((p) => p.id === 't-walk')).toBe(false);
      const p = pin(width, 'walkBuilt', 't-walk');
      expect(p.shown).toBe(true);
      expect(near(p, look(width, 'walkBuilt').el['walk-step'], 30)).toBe(true);
    });

    it('reopens its thread when the pin is tapped', () => {
      expect(look(width, 'reloaded').popover, 'CONTROL: nothing open before').toBeNull();
      expect(look(width, 'pinTapped').popover).toContain('Confirmed by whom?');
    });

    it('says open, resolved or review item at a glance, in one pin style', () => {
      const l = look(width, 'reloaded');
      const state = (id: string) => pin(width, 'reloaded', id).state;
      expect(['t-space', 't-chip', 't-tide', 't-title'].map(state)).toEqual([
        'open',
        'open',
        'open',
        'open',
      ]);
      expect(state('t-resolved')).toBe('resolved');
      expect(state('t-review')).toBe('review');
      // Painted differently: an orange drop, a white one ringed in green, and
      // an orange one with a white eye.
      const open = pin(width, 'reloaded', 't-space').paint;
      const resolved = pin(width, 'reloaded', 't-resolved').paint;
      const review = pin(width, 'reloaded', 't-review').paint;
      expect(open).toEqual(['rgb(227, 111, 30)', 'none', 'rgb(255, 255, 255)']);
      expect(resolved).toEqual(['rgb(255, 255, 255)', 'none', 'rgb(45, 164, 78)']);
      expect(review[1]).toMatch(/^radial-gradient\(rgb\(255, 255, 255\).*rgb\(227, 111, 30\)/);
      // One style: a drop with no number in it, the same drop on every open
      // thread, one pin per pinned thread.
      expect(l.pins.map((p) => p.text)).toEqual(l.pins.map(() => ''));
      expect(pin(width, 'reloaded', 't-chip').paint).toEqual(open);
      expect(l.pins.length).toBe(14);
    });
  });
});
