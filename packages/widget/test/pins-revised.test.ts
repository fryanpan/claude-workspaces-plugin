/**
 * A comment's pin stays on its element on a data mock that is redrawn, and on
 * one its author revised in place, measured in a real browser at 1180x820.
 *
 * What a reviewer found on a data mock (2026-10-20): his pins went from the
 * page while every thread stayed in the list. Loaded headless, the mock
 * redrew its charts and map without losing a pin; what lost them was the
 * mock's next round. A revision added paragraphs and sections above the
 * commented elements, and an anchor is scored partly on its element's index
 * among its siblings, so a heading whose words were unchanged scored under
 * the bar on its index alone and its thread went to the list as an orphan.
 *
 * `pins-revised-driver.ts` drives the page; this file asserts on what it
 * measured.
 *
 * audit: no-text — the driver measures a running browser; nothing here reads
 * a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { Look, Reading } from './pins-revised-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'pins-revised-driver.ts');
const SUITE_MS = 120_000;
const SHOWN = ['t-heading', 't-para', 't-cell', 't-label'] as const;

let reading: Reading;
const look = (name: string): Look => {
  const l = reading.looks[name];
  if (!l) throw new Error(`no look "${name}"`);
  return l;
};

/** Every thread on a shown element has a painted pin within a pin's reach of
 *  that element; the one on the hidden screen has none. */
function expectPinsOnTheirElements(name: string): void {
  const l = look(name);
  for (const id of SHOWN) {
    const p = l.pins[id];
    const b = l.el[id];
    expect(b, `${name}: CONTROL, ${id}'s element is on the page`).toBeTruthy();
    expect(p?.shown, `${name}: ${id} has a pin`).toBe(true);
    if (!p || !b) continue;
    const [x, y] = p.tip;
    expect(
      x >= b[0] - 40 && x <= b[2] + 40 && y >= b[1] - 40 && y <= b[3] + 40,
      `${name}: ${id} at ${p.tip} by ${b}`,
    ).toBe(true);
  }
  expect(l.el['t-hidden'], `${name}: CONTROL, the hidden screen has no box`).toBeNull();
  expect(l.pins['t-hidden']?.shown ?? false, `${name}: no pin on the hidden screen`).toBe(false);
}

describe.skipIf(CHROME === null)('pins on a data mock', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SUITE_MS - 10_000 });
    expect(r.status, r.stderr).toBe(0);
    reading = JSON.parse(r.stdout) as Reading;
  }, SUITE_MS);

  it('stands every pin on its element on the page as first drawn', () => {
    expectPinsOnTheirElements('static');
  });

  it('follows the element when the page draws its chart and rebuilds a row afresh', () => {
    // CONTROL: the label and the cell the pins stood on are gone from the
    // page, replaced by new elements saying the same words.
    expect(reading.replaced).toEqual({ label: true, cell: true });
    expectPinsOnTheirElements('redrawn');
  });

  it('keeps every pin on its element after the mock is revised around it', () => {
    // CONTROL: the revision added a heading above the commented one and a
    // row above the commented cell.
    expect(look('revised').h3s).toBe(look('static').h3s + 1);
    expect(look('revised').rows).toBe(look('static').rows + 1);
    expectPinsOnTheirElements('revised');
  });
});
