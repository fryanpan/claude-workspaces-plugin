/**
 * "Show estimates" in a real browser: a board that never set it shows no
 * estimate on the board, Home, a task's page or the review queue, at 1180x820
 * and at 430; turned on, the board and the task page show them; and a flip on
 * one open tab reaches another open tab within a second (Bryan, 1 Nov:
 * "default to having the setting off on all boards and hide all estimation
 * stuff on all screens behind that setting").
 *
 * `packages/server/test/show-estimates-browser-driver.ts` builds the client,
 * drives two headless tabs against a real server whose tickets carry real
 * estimates, and prints what each page drew. Every page also reports its
 * positive control, so a page that never mounted fails rather than reading as
 * clean. Run against the commit before the setting, the same driver reports
 * the goal strip and Hands-on on the off readings and no settings row.
 *
 * audit: no-text — the driver reads a running server and page; nothing here
 * reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { ShowEstimatesReading } from '../../server/test/show-estimates-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, '../../server/test/show-estimates-browser-driver.ts');
/** A client build, one launch, two tabs and twenty page loads. */
const SUITE_MS = 300_000;
const SPAWN_MS = 290_000;

let r: ShowEstimatesReading;

describe.skipIf(CHROME === null)('show estimates', () => {
  beforeAll(() => {
    const run = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as ShowEstimatesReading;
  }, SUITE_MS);

  for (const size of ['ipad', 'phone'] as const) {
    for (const surface of ['board', 'home', 'task', 'review'] as const) {
      it(`a board that never set it shows no estimate on ${surface} at ${size}`, () => {
        expect(r.off[size][surface].kept).toBe(true);
        expect(r.off[size][surface].estimates).toEqual([]);
      }, 60_000);
    }
    for (const surface of ['board', 'task'] as const) {
      it(`turned on, ${surface} at ${size} shows its estimates`, () => {
        expect(r.on[size][surface].kept).toBe(true);
        expect(r.on[size][surface].estimates.length).toBeGreaterThan(0);
      }, 60_000);
    }
  }

  it('the settings page draws the row, and its owner can change it', () => {
    expect(r.toggle).toEqual({ found: true, editable: true });
  }, 60_000);

  it('turning it on in one tab draws the goal strip in another within 1s', () => {
    expect(r.flipOn.startedOpposite).toBe(true);
    expect(r.flipOn.within1s).toBe(true);
  }, 60_000);

  it('turning it off in one tab takes Hands-on off another tab’s task page within 1s', () => {
    expect(r.flipOff.startedOpposite).toBe(true);
    expect(r.flipOff.within1s).toBe(true);
  }, 60_000);

  it('the pages threw nothing', () => {
    expect(r.errors).toEqual([]);
  }, 60_000);
});
