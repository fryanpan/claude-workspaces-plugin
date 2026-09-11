/**
 * Pressing the widget's own controls does not start a comment about them.
 *
 * THE REPORT. On a published mockup — a ~300KB single-file report drawn by
 * JavaScript, with SVG charts whose labels the reader was anchoring comments
 * on — pressing Post "immediately starts a new comment at the location of the
 * post button". Cancel and the banner's Done are the same control surface and
 * were never separately safe.
 *
 * THE CAUSE. Feedback mode arms a capture-phase `pointerup` listener on
 * `window`, which asked "was this press mine?" by running a SECOND hit test —
 * `document.elementFromPoint(clientX, clientY)` — rather than by reading the
 * press's own path. In Chromium that second hit test retargets shadow content
 * to the host, so a press on the composer read back as
 * `<claude-feedback-widget>` and was correctly declined; the guard was
 * therefore correct by accident, and only in engines that retarget.
 *
 * WHY THE `pierce` CASES EXIST. This file could not reproduce the report in
 * Chromium at either width — with retargeting the press on Post is declined
 * every time, which is why the plain cases below pass with or without the
 * fix. So the condition the guard was relying on is REMOVED instead: the
 * `pierce` pages install a `document.elementFromPoint` that answers with the
 * inner shadow node, which is what an engine that does not retarget hands
 * back. Under it, and before the fix, this file measured exactly the reported
 * symptom — zero comments posted and a fresh composer opened ON the Post
 * button, quoting the word "Post", at the button's own coordinates. It is a
 * fault injected into the PAGE, not a stub of the widget: the widget under
 * test is the shipped bundle, and the presses are real ones the browser
 * routes (`post-click-driver.ts` says why they have to be).
 *
 * audit: no-text — the driver measures a running browser; nothing here reads
 * a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import type { Reading } from './post-click-driver.ts';

/** Is there a browser to launch — asked the way `ui-shot.ts` asks, so the
 *  cases run on a CI runner that names no path rather than silently skipping
 *  everywhere but this laptop. */
const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();

const DRIVER = join(import.meta.dirname, 'post-click-driver.ts');

/**
 * One launch, four page loads and about thirty real presses. Vitest's default
 * case budget is 5s and a bare Chrome launch is already 4-6s on this machine,
 * so both budgets are named: the case's, and the subprocess's.
 */
const SUITE_MS = 300_000;
const SPAWN_MS = 280_000;

/** The words a composer quotes when it has been opened on the widget's own
 *  chrome — the bug's fingerprint, whatever else is on the page. */
const CHROME_SUBJECTS = ['Post', 'Cancel', 'Done (Esc)', 'Click anything to comment.'];

let readings: Reading[] = [];

/** The reading for one page load, named the way the failure message should
 *  read: "1180 with a hit test that does not retarget". */
const at = (width: number, pierce: boolean): Reading => {
  const r = readings.find((x) => x.width === width && x.pierce === pierce);
  if (!r) throw new Error(`no reading for ${width} pierce=${pierce}`);
  return r;
};

describe.skipIf(CHROME === null)('a press on the widget is not a press on the page', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    readings = JSON.parse(r.stdout) as Reading[];
    // The control for everything below: four page loads actually ran.
    expect(readings.map((x) => `${x.width}/${x.pierce}`)).toEqual([
      '1180/false',
      '1180/true',
      '430/false',
      '430/true',
    ]);
  }, SUITE_MS);

  for (const width of [1180, 430]) {
    for (const pierce of [false, true]) {
      const how = pierce ? 'where the hit test does not retarget' : 'in an ordinary browser';

      describe(`at ${width} ${how}`, () => {
        it('posts the comment, and opens nothing on the Post button', () => {
          const r = at(width, pierce);
          // Nothing new opened about the button. At tablet width posting hands
          // the mode back a fresh page-level composer, which is the behaviour
          // the reopen is FOR; at phone width the mode rests in the banner.
          // Asserted before the post, because this is the site the reported
          // symptom shows up at: before the fix it read "Post".
          expect(CHROME_SUBJECTS).not.toContain(r.afterPost.snippet);
          expect(r.afterPost.snippet).toBe(width > 1100 ? 'About this page' : null);
          // Exactly one comment, on the element that was picked — not two, and
          // not none. Before the fix the pierce cases posted NOTHING: the
          // press was preventDefaulted before the button's own click ran.
          expect(r.afterPost.posts).toEqual([
            { snippet: r.secondAnchor, text: 'this label is wrong' },
          ]);
        });

        it('cancels without commenting on Cancel', () => {
          const r = at(width, pierce);
          // A composer was open over a page element for Cancel to dismiss.
          expect(r.thirdAnchor).not.toBeNull();
          expect(CHROME_SUBJECTS).not.toContain(r.thirdAnchor);
          // Cancel throws the draft away and hands the mode back — it starts
          // nothing about itself and posts nothing.
          expect(CHROME_SUBJECTS).not.toContain(r.afterCancel.snippet);
          expect(r.afterCancel.snippet).toBe(width > 1100 ? 'About this page' : null);
          expect(r.afterCancel.mode).toBe(true);
          expect(r.afterCancel.posts).toHaveLength(1);
        });

        it("leaves the mode on the banner's Done, commenting on nothing", () => {
          const r = at(width, pierce);
          expect(r.afterDone.mode).toBe(false);
          expect(CHROME_SUBJECTS).not.toContain(r.afterDone.snippet);
          expect(r.afterDone.posts).toHaveLength(1);
        });

        it('still picks the element under a press, and carries the draft onto the next', () => {
          const r = at(width, pierce);
          // The FAB is a widget control too: the mode has to arm.
          expect(r.armed).toBe(true);
          // A press on the page picks what is under it…
          expect(r.firstAnchor).toBe('Jan');
          expect(r.secondAnchor).toBe('May');
          expect(r.secondAnchor).not.toBe(r.firstAnchor);
          // …and re-anchoring moves the sentence rather than discarding it.
          expect(r.carried).toBe('this label');
        });
      });
    }
  }
});
