/**
 * The two-level presence strip (design F, Bryan 2026-11-15) in a real browser
 * at 1180x820 and 430x932. `presence-two-level-browser-driver.ts` drives a
 * real server, the real bundles and two signed-in people; these cases assert
 * on its JSON.
 *
 * What a fake DOM cannot say: that a person who opens another page in a
 * second browser moves between the strip's two groups on an already-open page
 * within a second, that Follow takes the reader's browser where they go, and
 * that the reader's own tap ends the follow.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { Round, TwoLevelRun } from './presence-two-level-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'presence-two-level-browser-driver.ts');
const SUITE_MS = 220_000;
const SPAWN_MS = 210_000;
/** Every surface is live: a change made elsewhere shows within 1s. The
 *  driver's polls give up at this bound, so a slower page fails the run. */
const LIVE_MS = 1000;

let run: TwoLevelRun | null = null;
const round = (width: number): Round => {
  const r = run?.rounds.find((x) => x.width === width);
  if (!r) throw new Error(`no round at ${width}`);
  return r;
};

describe.skipIf(CHROME === null)('the two-level presence strip, in a browser', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as TwoLevelRun;
  }, SUITE_MS);

  for (const width of [1180, 430]) {
    it(`draws a person on another page under "Elsewhere", with that page's title, at ${width}`, () => {
      const { elsewhere } = round(width);
      expect(elsewhere.ms).toBeLessThanOrEqual(LIVE_MS);
      const bob = elsewhere.rows.find((r) => r.name === 'Bob');
      expect(bob?.group).toBe('Elsewhere in Harborlight');
      // The doc's own title, never a file path on the host.
      expect(bob?.line).toBe('On quay.md');
      // CONTROL: the list was read, and holds somebody besides Bob.
      expect(elsewhere.rows.length).toBeGreaterThanOrEqual(2);
    }, 60_000);

    it(`moves that person under "Here with you" when they come to the reader's page at ${width}`, () => {
      const { here } = round(width);
      expect(here.ms).toBeLessThanOrEqual(LIVE_MS);
      expect(here.rows.find((r) => r.name === 'Bob')).toEqual({
        group: 'Here with you · Tasks',
        name: 'Bob',
        line: 'Here with you',
      });
      // The lead points at the Library, so stays elsewhere: one row per group.
      expect(here.rows.filter((r) => r.group.startsWith('Elsewhere')).length).toBe(1);
    }, 60_000);

    it(`takes the follower to the followed person's page at ${width}`, () => {
      const { followed } = round(width);
      expect(followed.ms).toBeLessThanOrEqual(LIVE_MS);
      expect(followed.address).toMatch(/^\/workspaces\/w-[^/]+\/docs\/d-[^/]+$/);
      expect(followed.ringOnBob).toBe(true);
      // The page the follow opened says why the reader is there.
      expect(followed.notice).toBe('Following Bob — tap the page to stop');
    }, 60_000);

    it(`ends the follow when the follower taps their own page at ${width}`, () => {
      const { followed, stopped } = round(width);
      expect(stopped.ringOnBob).toBe(false);
      expect(stopped.stored).toBeNull();
      expect(stopped.notice).toBe('Stopped following');
      // Bob went back to the board; Alice stayed on the doc.
      expect(stopped.leftPage).toBe(false);
      expect(stopped.address).toBe(followed.address);
    }, 60_000);
  }

  it('keeps the deck the same height and top on the board and on a doc', () => {
    for (const width of [1180, 430]) {
      const { deckOnBoard, deckOnDoc } = round(width);
      expect([deckOnDoc.y, deckOnDoc.h], `at ${width}`).toEqual([deckOnBoard.y, deckOnBoard.h]);
    }
  }, 60_000);
});
