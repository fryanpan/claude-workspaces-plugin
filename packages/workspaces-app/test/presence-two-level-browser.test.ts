/**
 * The two-level presence strip (design F, Bryan 2026-11-15) in a real browser
 * at 1180x820 and 430x932. `presence-two-level-browser-driver.ts` drives a
 * real server, the real bundles and two signed-in people; these cases assert
 * on its JSON.
 *
 * What a fake DOM cannot say: that a person who opens another page in a
 * second browser moves between the strip's two groups on an already-open page
 * within a second, that a person's card goes there once or follows, that
 * Follow takes the reader's browser where they go under a bar that says so,
 * that the bar's Stop ends it, and that the deck sits at the same place on
 * the board and on a doc.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { PRESENCE_PALETTE } from '../src/presence/presence-colours.ts';
// Types only: importing a value would run the driver in this process.
import type { Round, Row, TwoLevelRun } from './presence-two-level-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'presence-two-level-browser-driver.ts');
const SUITE_MS = 220_000;
const SPAWN_MS = 210_000;
/** Every surface is live: a change made elsewhere shows within 1s. The
 *  driver's polls give up at this bound, so a slower page fails the run. */
const LIVE_MS = 1000;

/** A palette colour as the browser reports a fill. */
const rgbOf = (hex: string): string =>
  `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

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
        // The heading already says "here"; the row names the page.
        line: 'On Tasks',
      });
      // The lead points at the Library, so stays elsewhere: one row per group.
      expect(here.rows.filter((r) => r.group.startsWith('Elsewhere')).length).toBe(1);
    }, 60_000);

    it(`opens a card on a row tap: where they are, Show me and Follow at ${width}`, () => {
      const { card } = round(width);
      expect(card).toEqual({
        name: 'Bob',
        tag: 'Here with you',
        where: 'Here with youOn Tasks',
        buttons: ['Show me', 'Follow'],
      });
    }, 60_000);

    it(`says who the reader follows in a bar, on the board and on the doc, at ${width}`, () => {
      const { barOnBoard, followed } = round(width);
      expect(barOnBoard.label).toBe('Following Bob');
      expect(barOnBoard.text).toBe('Following Bob');
      expect(barOnBoard.page).toBe('Tasks');
      expect(followed.bar.page).toBe('quay.md');
      if (width === 1180) {
        // Wide: at the bottom of the window.
        expect(followed.bar.box.y + followed.bar.box.h).toBeGreaterThan(820 - 80);
      } else {
        // Phone: under the header, above the page.
        expect(followed.bar.box.y).toBeLessThan(140);
      }
    }, 60_000);

    it(`takes the follower to the followed person's page at ${width}`, () => {
      const { followed } = round(width);
      expect(followed.ms).toBeLessThanOrEqual(LIVE_MS);
      expect(followed.address).toMatch(/^\/workspaces\/w-[^/]+\/docs\/d-[^/]+$/);
      expect(followed.ringOnBob).toBe(true);
    }, 60_000);

    it(`ends the follow when the follower taps Stop on the bar at ${width}`, () => {
      const { followed, stopped } = round(width);
      expect(stopped.ringOnBob).toBe(false);
      expect(stopped.bar).toBe(false);
      expect(stopped.stored).toBeNull();
      expect(stopped.notice).toBe('Stopped following');
      // Bob went back to the board; Alice stayed on the doc.
      expect(stopped.leftPage).toBe(false);
      expect(stopped.address).toBe(followed.address);
    }, 60_000);

    it(`goes to a person elsewhere from their card, once, at ${width}`, () => {
      const { went } = round(width);
      expect(went.card.tag).toBe('Elsewhere in Harborlight');
      expect(went.card.buttons).toEqual(['Go there', 'Follow']);
      expect(went.address).toMatch(/^\/workspaces\/w-[^/?]+(\?.*)?$/);
    }, 60_000);
  }

  it('names the lead the same on the board and on a doc', () => {
    for (const width of [1180, 430]) {
      const { here, followed } = round(width);
      const lead = (rows: Row[]) => rows.filter((r) => r.name !== 'Bob').map((r) => r.name);
      // The board's roster knows the lead by its id; both pages show its name.
      expect(lead(here.rows), `board at ${width}`).toEqual(['Harborlight']);
      expect(lead(followed.rows), `doc at ${width}`).toEqual(['Harborlight']);
    }
  }, 60_000);

  it('paints the lead in one palette colour, with the same initials, on the board and on a doc', () => {
    for (const width of [1180, 430]) {
      const { leadOnBoard, leadOnDoc } = round(width);
      // CONTROL: the circle was read, and is filled.
      expect(leadOnBoard.fill, `at ${width}`).toMatch(/^rgb\(/);
      expect(leadOnDoc, `at ${width}`).toEqual(leadOnBoard);
      expect(leadOnBoard.initials).toBe('H');
      // A colour of the palette (`presence-colours.ts`), the same on both
      // pages although the board knows the lead by its id and the doc by
      // its name.
      expect(PRESENCE_PALETTE.map(rgbOf), `at ${width}`).toContain(leadOnBoard.fill);
    }
  }, 60_000);

  it('draws the deck at the same place and size on the board and on a doc', () => {
    for (const width of [1180, 430]) {
      const { deckOnBoard, deckOnDoc } = round(width);
      expect(deckOnDoc, `at ${width}`).toEqual(deckOnBoard);
      // 104px in from the right on a wide screen, 140px on a phone.
      expect(deckOnBoard.x + deckOnBoard.w, `at ${width}`).toBe(width === 1180 ? 1076 : 290);
    }
  }, 60_000);
});
