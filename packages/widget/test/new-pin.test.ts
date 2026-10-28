/**
 * A comment just left on a served mock shows its pin on its element, before
 * and after the agent's next round is swapped into the open page.
 *
 * What the owner reported (2026-10-20): "I don't see any badges anchored on
 * the mockup after leaving a comment". The threads were stored and their
 * anchors resolved; what was gone was the pins' stylesheet. A served mock's
 * live script claims every `<style>` in the head as the round's own, so that
 * the next round can take them away, and the widget's own pin sheet sits in
 * the head too. The first swap removed it: every pin after that was an
 * unstyled empty box at the frame's top left, with no drop drawn.
 *
 * `new-pin-driver.ts` drives the page; this file asserts on what it measured.
 *
 * audit: no-text — the driver measures a running browser and server.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { type Reading, TARGETS, type Target, onElement } from './new-pin-page.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'new-pin-driver.ts');
/** One launch, one bundle build, sixteen comments across two widths. */
const SUITE_MS = 240_000;
const SPAWN_MS = 230_000;
const CASE_MS = 60_000;

let r: Reading | null = null;
const reading = (): Reading => {
  if (!r) throw new Error('the driver printed nothing');
  return r;
};

function expectPinsOnTheirElements(key: string): void {
  const run = reading().runs[key];
  expect(run, `no run "${key}"`).toBeTruthy();
  for (const name of Object.keys(TARGETS) as Target[]) {
    const a = run?.[name];
    // CONTROL: the comment landed, on the server and in the frame's doc.
    expect(a?.posted, `${key}: ${name} reached the board`).toBe(true);
    expect(a?.inFrame, `${key}: ${name} reached the frame`).toBe(true);
    expect(a?.el, `${key}: ${name}'s element is on the page`).toBeTruthy();
    expect(a?.pin?.drawn, `${key}: ${name} has a drawn pin`).toBe(true);
    expect(a && onElement(a), `${key}: ${name} at ${a?.pin?.tip} by ${a?.el}`).toBe(true);
  }
}

describe.skipIf(CHROME === null)('a new comment on a served mock', () => {
  beforeAll(() => {
    const out = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(out.status, out.stderr).toBe(0);
    r = JSON.parse(out.stdout.trim().split('\n').pop() ?? '') as Reading;
  }, SUITE_MS);

  for (const width of ['1180', '430']) {
    it(
      `stands its pin on its element at ${width} wide`,
      () => {
        expectPinsOnTheirElements(width);
      },
      CASE_MS,
    );

    it(
      `stands its pin on its element at ${width} wide after the next round is swapped in`,
      () => {
        // CONTROL: the round reached the open page without a reload.
        expect(reading().swapped[width]).toBe(true);
        expectPinsOnTheirElements(`${width}-swapped`);
      },
      CASE_MS,
    );
  }
});
