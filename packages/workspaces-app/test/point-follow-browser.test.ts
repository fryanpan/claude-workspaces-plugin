/**
 * Following, in a real browser: an agent's pointer reaches a follower on
 * every kind of place, and a follower tracks a person's page, panel and
 * scroll. At 1180x820 and 430x932. `point-follow-browser-driver.ts` drives
 * a real server and the real bundles; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { PointFollowRun } from './point-follow-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'point-follow-browser-driver.ts');
/** One bundle build, four launches, about forty moves. */
const SUITE_MS = 220_000;
const SPAWN_MS = 210_000;

/** Every move, in order, at each size. */
const MOVES = [
  'agent home',
  'agent review item',
  'agent task panel',
  'agent task thread',
  'agent goal panel',
  'agent library',
  'agent activity',
  'agent doc phrase',
  'agent doc scroll',
  'agent mock phrase',
  'agent board from a mock',
  'agent review queue',
  'agent review queue holds still',
  'person task panel',
  'person library',
  'person doc',
  'person doc scroll',
];

/** The places the board, or the doc already open, shows without a load. */
const IN_PLACE = new Set([
  'agent home',
  'agent review item',
  'agent task panel',
  'agent task thread',
  'agent goal panel',
  'agent library',
  'agent activity',
  'agent doc scroll',
  'agent review queue holds still',
  'person task panel',
  'person library',
  'person doc scroll',
]);

let run: PointFollowRun | null = null;
const result = (): PointFollowRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('following an agent or a person', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as PointFollowRun;
  }, SUITE_MS);

  it('makes every move at both sizes', () => {
    expect(result().steps.map((s) => `${s.width} ${s.what}`)).toEqual([
      ...MOVES.map((m) => `1180 ${m}`),
      ...MOVES.map((m) => `430 ${m}`),
    ]);
  }, 60_000);

  it('lands the follower on the page each move names', () => {
    for (const s of result().steps) expect(s.address, `${s.width} ${s.what}`).toBe(s.expected);
  }, 60_000);

  it('puts the place on screen: the phrase centred, the scroll reached, the mock row shown', () => {
    for (const s of result().steps) expect(s.placed, `${s.width} ${s.what}`).toBe(true);
  }, 60_000);

  it('shows a board place, or a scroll on the open doc, in place rather than loading', () => {
    for (const s of result().steps) {
      if (IN_PLACE.has(s.what)) expect(s.inPlace, `${s.width} ${s.what}`).toBe(true);
    }
  }, 60_000);
});
