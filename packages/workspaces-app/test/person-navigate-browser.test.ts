/**
 * An agent's `show_person` moves only the tab the owner is attending to, in
 * a real browser at 1180x820 and 430x932: the front tab goes to the doc and
 * the phrase, then to its top in place; a background tab in the same browser
 * and a tab on another device stay where they were.
 * `person-navigate-browser-driver.ts` drives a real server and the real
 * bundles; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { NavigateRun } from './person-navigate-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'person-navigate-browser-driver.ts');
/** One bundle build, four browsers, four moves. */
const SUITE_MS = 220_000;
const SPAWN_MS = 210_000;

let run: NavigateRun | null = null;
const result = (): NavigateRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)("an agent taking the owner's tab somewhere", () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as NavigateRun;
  }, SUITE_MS);

  it('makes both moves at both sizes', () => {
    expect(result().steps.map((s) => `${s.width} ${s.what}`)).toEqual([
      '1180 doc phrase',
      '1180 doc top',
      '430 doc phrase',
      '430 doc top',
    ]);
  }, 60_000);

  it('moves the attended tab onto the doc, at the place named', () => {
    const { workspaceId, docId } = result();
    for (const s of result().steps) {
      expect(s.front, `${s.width} ${s.what}`).toEqual({
        address: `/workspaces/${workspaceId}/docs/${docId}`,
        attending: true,
      });
      expect(s.placed, `${s.width} ${s.what}`).toBe(true);
    }
  }, 60_000);

  it('leaves a background tab and another device where they were', () => {
    const B = `/workspaces/${result().workspaceId}`;
    for (const s of result().steps) {
      expect(s.background, `${s.width} ${s.what}`).toEqual({
        address: `${B}/library`,
        attending: false,
      });
      expect(s.otherDevice, `${s.width} ${s.what}`).toEqual({
        address: `${B}/home`,
        attending: false,
      });
    }
  }, 60_000);
});
