/**
 * A secret ask's value box is one masked line, marked … where the value runs
 * past it, on both surfaces and at every viewport the board is used at.
 *
 * THE ASK (the board owner, 2026-09-12): a pasted key should behave like a
 * password field anywhere — masked as it arrives, one line tall, a literal …
 * where it is cut off, and an eye on the right. The box used to grow to three
 * lines as a key arrived, so a paste moved Save under the reader's thumb.
 *
 * WHY A REAL BROWSER. Height, scroll geometry and what is painted at a point
 * are all used layout, which happy-dom does not compute (`css-harness.ts`).
 *
 * THE CONTROLS, because a clean reading proves nothing on its own:
 *  - `linesInLong`: the pasted value really is three lines inside the box, so
 *    "the height did not change" is about a value that could have grown it.
 *  - `shortAtRest`: a value that fits carries no …, so the … is about length
 *    rather than about there being a value at all.
 *  - `scrollIfPulled`: the card's own first-draw scroll, run from the spot
 *    the reader scrolled to, moves the scroller — so a pull-back, had one
 *    happened, would show in `scrollAfterRenders`.
 *
 * Nothing below reads a file; the driver reads the two stylesheets to put
 * them in the page and carries the audit's marker for it. No value is ever
 * returned from the page — only rectangles, class names and offsets.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import type { Reading } from './secret-key-field-driver.ts';

const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();

const DRIVER = join(import.meta.dirname, 'secret-key-field-driver.ts');
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

const SIZES = ['1180x820', '430x844', '430x560', '390x844'] as const;
const SAVE = 'board-walk-cred-send';

let readings: Reading[] = [];
const label = (r: Reading): string => `${r.surface} ${r.width}x${r.height}`;

describe.skipIf(CHROME === null)('the value box on a secret ask', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    readings = JSON.parse(r.stdout) as Reading[];
    expect(readings.map(label)).toEqual([
      ...SIZES.map((s) => `home ${s}`),
      ...SIZES.map((s) => `panel ${s}`),
    ]);
  }, SUITE_MS);

  it('stays one line tall whatever is pasted into it', () => {
    for (const r of readings) {
      expect(r.fieldsLong, `${label(r)}: three fields`).toHaveLength(3);
      // CONTROL: the value is three lines, so it could have grown the box.
      for (const lines of r.linesInLong) {
        expect(lines, `${label(r)}: the paste is three lines of the box`).toBe(3);
      }
      expect(r.fieldsLong, `${label(r)}: field heights, empty → long`).toEqual(r.fieldsEmpty);
      expect(r.rowsLong, `${label(r)}: row heights, empty → long`).toEqual(r.rowsEmpty);
    }
  });

  it('marks a value longer than the box with a literal …, and a short one with nothing', () => {
    for (const r of readings) {
      for (const [i, m] of r.longAtRest.entries()) {
        expect(m.end, `${label(r)}: field ${i + 1} at rest shows … at its end`).toBe(true);
        expect(m.start, `${label(r)}: field ${i + 1} at rest shows its start`).toBe(false);
        expect(m.text, `${label(r)}: field ${i + 1}'s mark`).toEqual(['…']);
        expect(m.inside, `${label(r)}: field ${i + 1}'s mark is inside its box`).toBe(true);
      }
      for (const [i, m] of r.shortAtRest.entries()) {
        expect(m.text, `${label(r)}: field ${i + 1} holding a value that fits`).toEqual([]);
      }
      // With the caret at the end of the value, the part cut off is its start.
      expect(r.longFocused.start, `${label(r)}: caret at the end marks the start`).toBe(true);
      expect(r.longFocused.text, `${label(r)}: one mark while typing`).toEqual(['…']);
      // Let go, the box scrolls back to the start and marks the end again.
      expect(r.longBlurred.start, `${label(r)}: after blur, the start shows`).toBe(false);
      expect(r.longBlurred.end, `${label(r)}: after blur, the end is marked`).toBe(true);
      // Revealed, the value is still longer than the box.
      expect(r.longRevealed.end, `${label(r)}: revealed, still marked`).toBe(true);
      expect(r.longRevealed.inside, `${label(r)}: revealed mark inside the box`).toBe(true);
    }
  });

  it('leaves every point of Save answering for Save once all three are filled', () => {
    for (const r of readings) {
      expect(r.saveHits.length, `${label(r)}: points sampled on Save`).toBeGreaterThan(100);
      const elsewhere = r.saveHits.filter((h) => !h.includes(SAVE));
      expect(elsewhere, `${label(r)}: points on Save that answer for something else`).toEqual([]);
    }
  });

  it('does not pull back a reader who scrolled away while the form re-renders', () => {
    for (const r of readings) {
      // CONTROL: from here, the first-draw scroll would move the page.
      expect(r.scrollIfPulled, `${label(r)}: the first-draw scroll moves from here`).not.toBe(
        r.scrollAway,
      );
      expect(r.scrollAfterRenders, `${label(r)}: scroll after values and eye taps`).toBe(
        r.scrollAway,
      );
    }
  });
});
