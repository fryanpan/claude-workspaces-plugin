/**
 * A comment's pin stays on its element through three rounds of a mock whose
 * author changes a few of that element's words each round, measured in a
 * real browser at 1180x820.
 *
 * What a reviewer found on a data mock (2026-10-20): after a round of edits,
 * 19 of 29 open threads had lost their pins. Each anchor held the words its
 * element said when the comment was made, so an element that said a little
 * more or a little less each round soon matched nothing. Now a page that
 * finds a commented element tells the server what it says now, and the next
 * round is matched against those words.
 *
 * `pins-rewrite-driver.ts` drives the page and plays the server; this file
 * asserts on what it measured.
 *
 * audit: no-text — the driver measures a running browser; nothing here reads
 * a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { Look, Reading } from './pins-rewrite-driver.ts';
import { ROUNDS, THREADS } from './pins-rewrite-rounds.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'pins-rewrite-driver.ts');
const SUITE_MS = 180_000;

let reading: Reading;

/** Is `id`'s pin painted within a pin's reach of its element this round? */
function pinOnElement(l: Look, id: string): boolean {
  const p = l.pins[id];
  const b = l.el[id];
  if (!p?.shown || !b) return false;
  const [x, y] = p.tip;
  return x >= b[0] - 40 && x <= b[2] + 40 && y >= b[1] - 40 && y <= b[3] + 40;
}

const standing = (l: Look) => THREADS.filter((id) => pinOnElement(l, id));

describe.skipIf(CHROME === null)('pins on a mock rewritten each round', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SUITE_MS - 10_000 });
    expect(r.status, r.stderr).toBe(0);
    reading = JSON.parse(r.stdout) as Reading;
  }, SUITE_MS);

  it('stands every pin on its element in each of three rounds', () => {
    const { refreshed } = reading.runs;
    expect(refreshed).toHaveLength(ROUNDS.length);
    refreshed.forEach((l, round) => {
      // CONTROL: every element is on the page, saying this round's words,
      // and the round added rows above the cell.
      for (const id of THREADS) expect(l.el[id], `round ${round}: ${id}'s element`).toBeTruthy();
      expect(l.rows, `round ${round}: rows`).toBe(2 + round);
      expect(standing(l), `round ${round}`).toEqual([...THREADS]);
      expect(l.noSpot, `round ${round}: listed with no spot`).toEqual([]);
    });
    // The first round said what each anchor already holds; each later one
    // reported all three elements' new words.
    expect(reading.reported).toEqual([0, 3, 3, 3]);
  });

  it('loses the pins by the third round when the server keeps only the first words', () => {
    // The arm that shows what the refresh carries: the same rounds, with every
    // report dropped. A small change is still found; three rounds of them are not.
    const { kept } = reading.runs;
    expect(standing(kept[0] as Look)).toEqual([...THREADS]);
    expect(standing(kept[1] as Look)).toEqual([...THREADS]);
    expect(standing(kept[3] as Look)).toEqual([]);
  });

  it("lists a deleted element's thread with no spot, and puts its pin nowhere", () => {
    const { deleted } = reading.runs;
    const gone = deleted[2] as Look;
    // CONTROL: the paragraph is not on the page this round; the others are.
    expect(gone.el['t-para']).toBeNull();
    expect(standing(gone)).toEqual(['t-heading', 't-cell']);
    expect(gone.pins['t-para']?.shown ?? false).toBe(false);
    expect(gone.noSpot).toEqual(['t-para']);
    // And it stays without one in the round after.
    const after = deleted[3] as Look;
    expect(after.pins['t-para']?.shown ?? false).toBe(false);
    expect(after.noSpot).toEqual(['t-para']);
  });
});
