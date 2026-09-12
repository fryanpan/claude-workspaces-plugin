/**
 * Save answers its own tap on HOME, at every height a phone presents.
 *
 * THE FAULT. Home's Save button was painted underneath the fixed bottom nav
 * dock at any viewport shorter than about 900px — 430x844, 390x844, 430x700
 * and 430x560 all reproduced. Every point of Save hit-tested to
 * `board-nav-item`, and a real tap navigated to another page, abandoning a
 * form the reader had already pasted a key into (UX review, 2026-09-12). For
 * an ask whose whole point is that Bryan can answer it from his phone, that
 * is data loss.
 *
 * THE CAUSE, and why the previous round's fix could not work. A scroll
 * reserve belongs to the box that scrolls. In the task panel that is
 * `.board-detail-panel`, a real overflow box, and the reserve authored there
 * was honoured. On Home the walkthrough is a page in the Home column, so the
 * box that scrolls is the VIEWPORT — and a viewport takes its scroll-padding
 * from the ROOT element. `body.board-body`'s own `overflow: auto` propagates
 * to the viewport and leaves body a non-scrolling box, so a reserve written
 * there computed `auto` on `html` and moved nothing at all. The reserve now
 * sits on `html`, and it is the dock's height plus the row's, because what
 * ends this scrollport is a `position: fixed` bar that no amount of scrolling
 * gets out from under.
 *
 * WHY A REAL BROWSER. Every question here is "what is painted at this point",
 * and happy-dom lays nothing out — `css-harness.ts` says so — so
 * `elementFromPoint` there can only answer with the document. A fixed dock's
 * box, a `scrollIntoView` that honours `scroll-padding`, and a textarea grown
 * to three lines by `field-sizing: content` are all used geometry.
 *
 * THE CONTROLS, because a clean reading proves nothing on its own:
 *  - `unreserved` is the same first draw with the reserve taken off the
 *    element that scrolls — the page exactly as the UX walk found it. It has
 *    to put Save back under the dock at every size, or the reserve is not
 *    what is holding Save up.
 *  - `pageScrolls`, `navPosition` and the viewport list say the fixture still
 *    reproduces: a page that fits on screen, or one whose dock is not fixed,
 *    would pass every case below with the fix reverted.
 *  - the scroller is named in the reading, so a future refactor that gives
 *    Home a real overflow box fails here rather than silently measuring the
 *    wrong element's reserve.
 *
 * audit: not-source — nothing below reads a file; every value asserted on is
 * a rectangle or the name of the element painted at a point.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import type { Look, Reading } from './secret-save-home-driver.ts';

/** Is there a browser to launch — asked the way `ui-shot.ts` itself asks, so
 *  the case runs on a CI runner that names no path. */
const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();

const DRIVER = join(import.meta.dirname, 'secret-save-home-driver.ts');

/** One launch, four page loads, a paste and a tap in each. */
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

/** The heights a phone presents: keyboard down, and up by two amounts. */
const SIZES = ['390x844', '430x844', '430x700', '430x560'] as const;

let readings: Reading[] = [];
const at = (size: string): Reading => {
  const [w, h] = size.split('x').map(Number);
  const r = readings.find((x) => x.width === w && x.height === h);
  if (!r) throw new Error(`no reading at ${size}`);
  return r;
};

const SAVE = 'board-walk-cred-send';

/** Does this reading have Save under the dock? A point that answers with the
 *  nav, its mic or either one's glyph is a point whose tap goes to the nav. */
const onTheDock = (look: Look): boolean =>
  look.save.bottom > look.nav.top && look.hits.some((h) => h !== 'nothing' && !h.includes(SAVE));

describe.skipIf(CHROME === null)('the Save button on Home, at phone heights', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    readings = JSON.parse(r.stdout) as Reading[];
    expect(readings.map((x) => `${x.width}x${x.height}`)).toEqual([...SIZES]);
  }, SUITE_MS);

  it('CONTROL: the fixture still reproduces — a fixed dock over a page that scrolls', () => {
    for (const size of SIZES) {
      const r = at(size);
      // A page that fits on screen has no scroll to get wrong, and a dock in
      // the flow would move out of the way on its own.
      expect(r.pageScrolls, `${size}: the page scrolls`).toBe(true);
      expect(r.navPosition, `${size}: the dock is fixed`).toBe('fixed');
      expect(r.firstDraw.nav.bottom, `${size}: the dock sits on the bottom edge`).toBe(r.height);
      expect(r.firstDraw.nav.top, `${size}: the dock has height`).toBeLessThan(r.height);
      // Five points on Save, or the hit tests below are asserting on nothing.
      expect(r.firstDraw.hits, `${size}: points on Save`).toHaveLength(5);
      expect(r.firstDraw.save.bottom - r.firstDraw.save.top).toBeGreaterThanOrEqual(44);
    }
  });

  it('CONTROL: with the reserve off the element that scrolls, Save is back under the dock', () => {
    // The page as the UX walk found it. If this ever reads clean, the case
    // below is passing on a fixture that cannot fail.
    for (const size of SIZES) {
      const r = at(size);
      expect(onTheDock(r.unreserved), `${size}: Save is under the dock without the reserve`).toBe(
        true,
      );
      expect(
        r.unreserved.hits.filter((h) => h.includes(SAVE)),
        `${size}: no point of Save answers for itself without the reserve`,
      ).toEqual([]);
    }
  });

  it('puts the reserve on the box that actually scrolls', () => {
    // The fault was a reserve on `body`, which does not scroll: its own
    // `overflow: auto` propagates to the viewport. So the assertion is about
    // WHICH element carries it, not that some element does.
    for (const size of SIZES) {
      const r = at(size);
      expect(r.scroller, `${size}: the page's scroller`).toBe('HTML');
      expect(r.htmlReserve, `${size}: the scroller's own reserve`).not.toBe('auto');
      const reserved = Number.parseFloat(r.htmlReserve);
      expect(reserved, `${size}: the reserve clears the dock and the row`).toBeGreaterThan(
        r.firstDraw.nav.bottom - r.firstDraw.nav.top,
      );
    }
  });

  it('answers its own tap where the reader first meets the form', () => {
    for (const size of SIZES) {
      const r = at(size);
      expect(r.firstDraw.hits, `${size}: every point of Save as drawn`).toEqual(
        r.firstDraw.hits.map(() => r.firstDraw.hits[0]),
      );
      for (const [i, hit] of r.firstDraw.hits.entries()) {
        expect(hit, `${size}: point ${i} on Save as drawn`).toContain(SAVE);
      }
      expect(r.firstDraw.save.bottom, `${size}: Save is clear of the dock`).toBeLessThanOrEqual(
        r.firstDraw.nav.top,
      );
    }
  });

  it('comes up with the field, and still answers its own tap, when one is tapped', () => {
    for (const size of SIZES) {
      const r = at(size);
      // The LAST field is the one that has to carry Save into view: a reader
      // in the first still has the others to fill.
      expect(r.focused.focusedField, `${size}: the last field took the tap`).toBe(
        'secret:saltmarsh-relay-endpoint',
      );
      for (const [i, hit] of r.focused.hits.entries()) {
        expect(hit, `${size}: point ${i} on Save with a field tapped`).toContain(SAVE);
      }
      expect(r.focused.save.bottom, `${size}: Save is clear of the dock`).toBeLessThanOrEqual(
        r.focused.nav.top,
      );
      const last = r.focused.fields.at(-1);
      expect(r.focused.fieldHits.at(-1), `${size}: the tapped field answers for itself`).toContain(
        'board-walk-cred-input',
      );
      expect(last?.bottom, `${size}: and it is clear of the dock too`).toBeLessThanOrEqual(
        r.focused.nav.top,
      );
    }
  });

  it('sends a half-filled form to a field the reader can reach', () => {
    // Pressing Save with a box still empty puts the caret in that box rather
    // than saving. Save itself goes below the fold here and that is right —
    // the reader has been sent back UP the form — but the box they were sent
    // to has to be somewhere a thumb can land.
    for (const size of SIZES) {
      const r = at(size);
      expect(r.message.focusedField, `${size}: sent to the empty box`).toBe(
        'secret:saltmarsh-relay-account',
      );
      expect(r.message.fieldHits[0], `${size}: the empty box answers its own tap`).toContain(
        'board-walk-cred-input',
      );
      const box = r.message.fields[0];
      expect(box?.bottom, `${size}: and it is clear of the dock`).toBeLessThanOrEqual(
        r.message.nav.top,
      );
      expect(box?.top, `${size}: and of the top edge`).toBeGreaterThanOrEqual(0);
    }
  });
});
