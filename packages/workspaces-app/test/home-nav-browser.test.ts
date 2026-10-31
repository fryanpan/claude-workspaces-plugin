/**
 * Home's bottom bar on a phone: Review items, Inbox, Projects and Coach, each
 * an icon and a label drawn with a workspace navbar's markup and classes, so
 * the two bars read as one product. Tapping an entry brings its section into
 * view above the bar, and at 1180x820 the bar is not there and moves nothing
 * (Bryan, 31 Oct: "From home can you give me on mobile a navbar to go between
 * review items, inbox, projects, coach").
 *
 * And a workspace's own navbar sits at the bottom at every width up to 1100,
 * not only at 900 and under (Bryan: "Just put it at the bottom").
 *
 * `packages/server/test/home-nav-browser-driver.ts` signs in as the owner and
 * does the reading. Which entries a non-owner gets is the route test,
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
/** A client build, one launch and five page loads. */
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

let r: HomeNavReading;

describe.skipIf(CHROME === null)("Home's bottom bar, and a workspace's navbar", () => {
  beforeAll(() => {
    const run = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as HomeNavReading;
  }, SUITE_MS);

  it('at 430 wide shows Review items, Inbox, Projects and Coach, each with an icon', () => {
    expect(r.phone.labels).toEqual(['Review items', 'Inbox', 'Projects', 'Coach']);
    expect(r.phone.icons).toEqual([true, true, true, true]);
  }, 60_000);

  it('sits on the bottom edge of the screen, wherever the page is scrolled', () => {
    for (const p of [r.phone.placeTop, r.phone.placeEnd]) {
      expect(p.position).toBe('fixed');
      expect(p.bottom).toBe(p.innerHeight);
      expect(p.top).toBeGreaterThan(p.innerHeight / 2);
    }
  }, 60_000);

  it('looks like a workspace’s bottom bar: same layout, size, type and colour', () => {
    // CONTROL: the workspace's bar really is the bottom bar at this width, so
    // the comparison is against the thing Home is meant to match.
    expect(r.phone.workspace.bar.position).toBe('fixed');
    expect(r.phone.workspace.item.flexDirection).toBe('column');
    expect(r.phone.home).toEqual(r.phone.workspace);
  }, 60_000);

  it('tapping each entry brings its section into view, above the bar', () => {
    expect(r.phone.taps.map((t) => t.label)).toEqual([
      'Projects',
      'Coach',
      'Inbox',
      'Review items',
    ]);
    for (const t of r.phone.taps) {
      // CONTROL: the section started out of view, so a landing is the tap's.
      expect(t.before < 0 || t.before >= t.innerHeight / 2, t.label).toBe(true);
      expect(t.after, t.label).toBeGreaterThanOrEqual(0);
      expect(t.after, t.label).toBeLessThan(t.innerHeight / 2);
      expect(t.after, t.label).toBeLessThan(t.barTop);
    }
  }, 60_000);

  it('no entry moves or resizes as the page scrolls under it', () => {
    expect(r.phone.boxesBefore).toHaveLength(4);
    expect(r.phone.boxesAfter).toEqual(r.phone.boxesBefore);
  }, 60_000);

  it('at 1180x820 there is no bar, and taking it out moves nothing on the page', () => {
    expect(r.desktop.display).toBe('none');
    expect(r.desktop.height).toBe(0);
    // CONTROL: the landmarks were all found, so equal lists are a reading.
    expect(r.desktop.withBar.filter((m) => m.endsWith('missing'))).toEqual([]);
    expect(r.desktop.withoutBar).toEqual(r.desktop.withBar);
  }, 60_000);

  it('the page threw nothing', () => {
    expect(r.errors).toEqual([]);
  }, 60_000);

  describe("a workspace's navbar", () => {
    it('at 1000 wide sits on the bottom edge of the screen', () => {
      const p = r.workspace1000;
      expect(p.position).toBe('fixed');
      expect(p.bottom).toBe(p.innerHeight);
      expect(p.top).toBeGreaterThan(p.innerHeight / 2);
    }, 60_000);

    it('at 1180 wide is still the rail down the left, not a bottom bar', () => {
      expect(r.workspace1180.position).not.toBe('fixed');
      expect(r.workspace1180.top).toBeLessThan(r.workspace1180.innerHeight / 2);
    }, 60_000);
  });
});
