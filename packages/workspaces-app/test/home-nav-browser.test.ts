/**
 * Home's section bar on a phone: tapping Review items, Inbox, Projects or
 * Coach brings that section into view, just below the bar, and the bar is not
 * there at 1180x820 (Bryan, 31 Oct: "From home can you give me on mobile a
 * navbar to go between review items, inbox, projects, coach").
 *
 * `packages/server/test/home-nav-browser-driver.ts` signs in as the owner,
 * scrolls each section out of view at 430x932, taps its entry with a trusted
 * touch and reads where the section landed; then opens Home at 1180x820.
 * Which entries a non-owner gets is the route test,
 * `packages/server/test/landing-section-nav.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { HomeNavReading } from '../../server/test/home-nav-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, '../../server/test/home-nav-browser-driver.ts');
/** A client build, one launch and two page loads. */
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

let r: HomeNavReading;

describe.skipIf(CHROME === null)("Home's section bar", () => {
  beforeAll(() => {
    const run = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as HomeNavReading;
  }, SUITE_MS);

  it('at 430 wide shows Review items, Inbox, Projects and Coach', () => {
    expect(r.phone.labels).toEqual(['Review items', 'Inbox', 'Projects', 'Coach']);
  }, 60_000);

  it('tapping each entry brings its section into view, just below the bar', () => {
    expect(r.phone.taps.map((t) => t.label)).toEqual([
      'Projects',
      'Coach',
      'Inbox',
      'Review items',
    ]);
    for (const t of r.phone.taps) {
      // CONTROL: the section started out of view, so a landing is the tap's.
      expect(t.before < t.barBottom || t.before >= t.innerHeight / 2, t.label).toBe(true);
      expect(t.after, t.label).toBeGreaterThanOrEqual(t.barBottom);
      expect(t.after, t.label).toBeLessThan(t.innerHeight / 2);
    }
  }, 60_000);

  it('no entry moves or resizes as the page scrolls under it', () => {
    expect(r.phone.boxesBefore).toHaveLength(4);
    expect(r.phone.boxesAfter).toEqual(r.phone.boxesBefore);
  }, 60_000);

  it('at 1180x820 there is no bar and it takes no space', () => {
    expect(r.desktop).toEqual({ display: 'none', height: 0 });
  }, 60_000);

  it('the page threw nothing', () => {
    expect(r.errors).toEqual([]);
  }, 60_000);
});
