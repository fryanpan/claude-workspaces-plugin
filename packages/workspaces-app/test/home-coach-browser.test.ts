/**
 * The coach is not on Home (Bryan: "Coach should not be on home page"), and
 * it is still on its own Coach board. Read in a real browser on the iPad in
 * landscape and on a phone: Home draws no coach section, no coach card and no
 * Coach nav entry, and makes no request to the coach; the Coach board draws
 * the coach card for an offered moment and lists the Learning goals doc.
 *
 * `packages/server/test/home-coach-browser-driver.ts` signs in as the owner,
 * sets the coach up, and does the reading. The markup of Home without the
 * coach is the route test, `packages/server/test/landing-section-nav.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { HomeCoachReading } from '../../server/test/home-coach-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, '../../server/test/home-coach-browser-driver.ts');
/** A client build, one launch and five page loads. */
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

let r: HomeCoachReading;

describe.skipIf(CHROME === null)('the coach is on its board, not on Home', () => {
  beforeAll(() => {
    const run = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as HomeCoachReading;
  }, SUITE_MS);

  for (const [width, height] of [
    [1180, 820],
    [430, 932],
  ] as const) {
    it(`at ${width}x${height} Home has no coach section, card or Coach entry`, () => {
      const s = r.sizes.find((x) => x.width === width && x.height === height);
      // CONTROL: the owner's page, with its review region drawn.
      expect(s?.home.review, 'review region').not.toBeNull();
      expect(s?.home.coach, 'coach region').toBeNull();
      expect(s?.home.coachCards).toBe(0);
      expect(s?.home.coachRequests).toEqual([]);
      expect(s?.home.navLabels).not.toContain('Coach');
    }, 60_000);

    it(`at ${width}x${height} the Coach board shows the coach card and Learning goals`, () => {
      const s = r.sizes.find((x) => x.width === width && x.height === height);
      // CONTROL for Home's empty list: the board's card talks to the coach.
      expect(s?.coachBoard.coachRequests).toContain('/coach/here');
      expect(s?.coachBoard.coachCard).toBe(true);
      expect(s?.coachBoard.learningGoals).toBe(true);
    }, 60_000);
  }

  it('the pages threw nothing', () => {
    expect(r.errors).toEqual([]);
  }, 60_000);
});
