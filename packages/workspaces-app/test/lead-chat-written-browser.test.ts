/**
 * The lead's written answer to a spoken question shows in the board's chat
 * and its link can be tapped: within 1s when the chat is open, and there
 * when the reader opens it later — with voice on in the bar, or after they
 * left the page that asked. At 1180x820 and 430x932.
 * `lead-chat-written-browser-driver.ts` drives a real server and the real
 * bundles; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { WrittenRun } from './lead-chat-written-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-chat-written-browser-driver.ts');
/** One bundle build, two launches, fourteen page loads. */
const SUITE_MS = 220_000;
const SPAWN_MS = 210_000;

let run: WrittenRun | null = null;
const result = (): WrittenRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('the lead’s written answer, in the chat', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as WrittenRun;
  }, SUITE_MS);

  it('runs every way at both sizes', () => {
    expect(result().cases.map((c) => `${c.width} ${c.way}`)).toEqual([
      '1180 open',
      '1180 closed',
      '1180 left',
      '430 open',
      '430 closed',
      '430 left',
    ]);
  }, 60_000);

  it('shows the written link within 1s of the chat being open with the answer sent', () => {
    for (const c of result().cases) {
      expect(c.shown, `${c.width} ${c.way}`).toBe(true);
      expect(c.href, `${c.width} ${c.way}`).toBe(result().docPath);
    }
  }, 60_000);

  it('lands on the doc when the link is tapped', () => {
    for (const c of result().cases) {
      expect(new URL(c.landed).pathname, `${c.width} ${c.way}`).toBe(result().docPath);
    }
  }, 60_000);

  it('says the answer was delivered, because the wait follows the speaker to their next page', () => {
    for (const c of result().cases) expect(c.delivered, `${c.width} ${c.way}`).toBe(true);
  }, 60_000);
});
