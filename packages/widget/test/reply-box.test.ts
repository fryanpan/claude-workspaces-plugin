/**
 * A thread opened from the Feedback panel's list shows its reply box and
 * Reply button inside the window, measured in a real browser at 1180x820
 * (iPad landscape) and 430x900.
 *
 * Bryan, on a mock: "the comment opens up with the reply box cutoff past the
 * fold and I can't reply with enter and the button's not visible". The list
 * scrolls the thread's element to the middle of the window, but an element on
 * a page's last lines cannot go higher than the bottom of the screen, and the
 * popover opened beside it was kept only 240px clear of the bottom edge. A
 * popover with an exchange in it is taller than that, and one holding an
 * agent's decision taller still.
 *
 * And on an iPhone, Bryan again, with the keyboard up (29 Oct): Reply and
 * Resolve were drawn over the last line of the agent's answer and the top of
 * the reply box. The box was 12px, so Safari zoomed the page when it took
 * focus, and the two buttons were a wrapped flex line under the box. Now the
 * box is 16px and the buttons are a grid row of their own; the cases below
 * read where every line of comment text, the box and both buttons landed.
 *
 * `reply-box-driver.ts` drives the page; this file asserts on what it
 * measured.
 *
 * audit: no-text — the driver measures a running browser; nothing here reads
 * a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { Box, Reading } from './reply-box-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'reply-box-driver.ts');
const SUITE_MS = 120_000;
/** The sizes the driver measures at, as it lists them. */
const SIZES = [
  [1180, 820],
  [430, 900],
] as const;

let reading: Reading;

const inside = (b: Box | null, w: number, h: number): boolean =>
  !!b && b[0] >= 0 && b[1] >= 0 && b[2] <= w && b[3] <= h;

/** The reply box and its button, whole, inside the window and the popover. */
function expectReplyable(size: string, id: string): void {
  const l = reading[`${size}:${id}`];
  expect(l, `${size}: ${id} was measured`).toBeTruthy();
  if (!l) return;
  const [w, h] = l.win;
  expect(l.pop, `${size}: ${id}'s popover opened`).not.toBeNull();
  expect(inside(l.box, w, h), `${size}: ${id}'s reply box ${l.box} in ${w}x${h}`).toBe(true);
  expect(inside(l.send, w, h), `${size}: ${id}'s Reply button ${l.send} in ${w}x${h}`).toBe(true);
  // Not cut off by the popover's own edge either.
  const p = l.pop as Box;
  expect(l.send && l.send[3] <= p[3], `${size}: ${id}'s button inside its popover`).toBe(true);
  // And it holds where it opened.
  expect(l.popLater, `${size}: ${id}'s popover stays put`).toEqual(l.pop);
}

const meets = (a: Box, b: Box): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** Reply and Resolve sit under the box, and neither covers the box or a word. */
function expectClear(key: string): void {
  const l = reading[key];
  expect(l, `${key} was measured`).toBeTruthy();
  if (!l?.box || !l.send) throw new Error(`${key}: no reply box or Reply button`);
  // Under 16px iOS zooms the page on focus, the state the overlap was seen in.
  expect(l.fieldPx, `${key}: the reply box's font size`).toBeGreaterThanOrEqual(16);
  const buttons = [l.send, l.status].filter((b): b is Box => b !== null);
  // CONTROL: there was text to cover, and both buttons were drawn.
  expect(l.words.length, `${key}: comment lines in view`).toBeGreaterThan(0);
  expect(buttons.length, `${key}: Reply and Resolve`).toBe(2);
  for (const b of buttons) {
    expect(b[1] >= l.box[3], `${key}: button ${b} under the box ${l.box}`).toBe(true);
    for (const w of l.words) expect(meets(b, w), `${key}: button ${b} over words ${w}`).toBe(false);
  }
}

describe.skipIf(CHROME === null)('a thread opened from the comment list', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SUITE_MS - 10_000 });
    expect(r.status, r.stderr).toBe(0);
    reading = JSON.parse(r.stdout) as Reading;
  }, SUITE_MS);

  for (const [w, h] of SIZES) {
    const size = `${w}x${h}`;
    it(`CONTROL at ${size}: a pin near the top of the page opens a reply box on screen`, () => {
      expectReplyable(size, 't-top');
    });

    it(`at ${size}: a pin on the page's last line opens a reply box on screen`, () => {
      // CONTROL: the list's scroll could not lift the element off the
      // bottom half of the window, which is the case under test.
      const el = reading[`${size}:t-bottom`]?.el;
      expect(el && el[1] > h / 2, `${size}: element at ${el}`).toBe(true);
      expectReplyable(size, 't-bottom');
    });

    it(`at ${size}: a thread holding an agent's decision opens a reply box on screen`, () => {
      expectReplyable(size, 't-ask');
    });

    for (const id of ['t-top', 't-bottom', 't-ask']) {
      it(`at ${size}: ${id}'s Reply and Resolve cover neither the box nor a word`, () => {
        expectClear(`${size}:${id}`);
      });
      // A decision's card fills a 520px window, leaving the list no lines.
      if (w > 1100 || id === 't-ask') continue;
      it(`at ${size} with the keyboard up: ${id}'s Reply and Resolve cover neither the box nor a word`, () => {
        expectClear(`${size}:${id}:typed`);
      });
    }
  }
});
