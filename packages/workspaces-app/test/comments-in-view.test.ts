/**
 * A comment sits in the margin beside the text it marks, and nowhere else —
 * measured with a meeting running under it.
 *
 * THE FAULT. A live transcript grows at the foot of the doc and a reader
 * watching it has scrolled the pane there, so every comment's sentence is a
 * screenful or more above the fold. The column then drew all of them anyway: `foldWithStrips`
 * floors every anchor at `scrollTop + band.top` so that no card comes to rest
 * under the new-content strip, and that floor does not ask whether the card's
 * own text is on screen. Measured at 1180x820 before the fix: four cards
 * painted in the visible column, four anchors between 4141 and 4226px above
 * it — a stack of comments against text the reader could not see.
 *
 * WHY A REAL BROWSER. Every question here is a used-geometry one — is this
 * rect inside that rect — and happy-dom lays nothing out (`css-harness.ts`
 * says so in full): `offsetHeight` is zero, so the column's whole fold path is
 * skipped there. Only measured rects can see this, which is what testing
 * standard 1 asks for and what `bun run ui:shot` gives.
 *
 * THE CONTROLS. `cards` and `beside` are why a reading of zero detached cards
 * means something: a column that rendered nothing, or a meeting that never
 * reached the foot, would report zero and prove nothing. `zoneOnScreen` and
 * `bandTop` say the pane really was at the transcript and the strip really
 * covered the column — the two conditions the fault needs.
 *
 * AND THE PAGE NEVER FOLLOWS (owner, 2026-09-11: "Never follow"). A reader
 * at the top, beside the comments, stays there while the transcript grows
 * past the fold, and reaches the words by scrolling down for them. The pane
 * used to pull itself down to the transcript, which is what took the
 * comments out of reach in the first place.
 *
 * AND TWO STATES THE FIRST FIX LEFT. A card whose text is just off the top,
 * near the top of the doc, has no room above the fold — and the column
 * clamped it to the document's top, back on screen. And a note landing above
 * the comments moves their text at once while the cards waited out the
 * column's 100ms debounce, beside the wrong lines or on screen for text that
 * had left it. `clamped` and `landed` are those two.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RUN_ID_ENV, profilesOfRun, resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import type { Probe } from './comments-in-view-driver.ts';

/** Is there a browser to launch — asked the way `ui-shot.ts` itself asks, so
 *  the case runs on a CI runner that names no path. It throws when nothing
 *  resolves, and a throw here would take the file down at load. */
const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();

const SRC = join(import.meta.dirname, '../src');
const SHOT = join(import.meta.dirname, '../../../scripts/ui-shot.ts');
const DRIVER = join(import.meta.dirname, 'comments-in-view-driver.ts');

// audit: not-source — the sheets are INSTALLED into a real browser and the
// bundle is EXECUTED by it; nothing below asserts on either one's text, and
// every expectation in this file is a measured rectangle.
const readText = (path: string): string => readFileSync(path, 'utf8');

/** A launch, a build and two meetings is well past vitest's 5s default, so
 *  both budgets are named: the case's, and the subprocess's. */
const BROWSER_CASE_MS = 180_000;
const SPAWN_MS = 170_000;

const dirs: string[] = [];
const owned: string[] = [];

/** The review editor's shell, as `app.ts` builds it around the doc. */
function page(bundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<style>${readText(join(SRC, 'board.css'))}</style>
<style>${readText(join(SRC, 'styles.css'))}</style>
<style>${readText(join(SRC, 'doc.css'))}</style>
<style>${readText(join(SRC, 'tokens.css'))}</style>
<style>html,body{margin:0;height:100%}#shell{height:100vh;display:flex}
#editor-pane{position:relative;display:flex;flex-direction:column;flex:1;min-width:0;height:100vh}
#editor{flex:1;min-height:0;overflow:auto}</style>
</head><body>
<div id="shell">
  <aside id="set-pane"></aside>
  <main id="editor-pane"><div id="editor" class="prose"></div></main>
  <aside id="threads-pane">
    <div class="threads-tabs"><button class="tab active" data-tab="open">Open</button><button class="tab" data-tab="resolved">Resolved</button></div>
    <button id="toggle-threads">t</button><span id="threads-count"></span><button id="close-threads">x</button>
    <ol id="threads-list"></ol>
  </aside>
  <div id="threads-scrim"></div>
  <div id="doc-title"></div>
  <div id="composer" class="hidden"><div id="composer-avatar"></div><div id="composer-quote"></div><textarea id="composer-text"></textarea><button id="composer-submit">Post</button></div>
  <div id="composer-scrim" class="hidden"></div>
  <div id="thread-view" class="hidden"><button id="thread-view-close">x</button><div id="thread-view-body"></div><textarea id="thread-view-reply-text"></textarea><button id="thread-view-reply-submit">Reply</button></div>
  <div id="toast" class="hidden"></div>
</div>
<script type="module">${bundle}</script>
</body></html>`;
}

/** Build the driver — and the real editor, chrome, column and zone it imports
 *  — for the browser. */
function buildPage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-comments-in-view-'));
  dirs.push(dir);
  const bundle = join(dir, 'driver.js');
  const built = spawnSync(
    'bun',
    ['build', DRIVER, '--target', 'browser', '--format', 'esm', '--outfile', bundle],
    { encoding: 'utf8', timeout: 120_000 },
  );
  expect(built.status, built.stderr).toBe(0);
  const html = join(dir, 'doc.html');
  writeFileSync(html, page(readText(bundle)));
  return html;
}

/** Drive one meeting at one of the two verified widths. */
function measure(html: string, preset: 'ipad' | 'phone'): Probe {
  const dir = mkdtempSync(join(tmpdir(), 'cw-comments-in-view-probe-'));
  dirs.push(dir);
  const file = join(dir, 'probe.js');
  writeFileSync(file, '(async () => await window.commentsInViewProbe())()');
  const runId = `civ${process.pid}${owned.length}`;
  owned.push(runId);
  const r = spawnSync(
    'bun',
    [SHOT, '--url', `file://${html}`, '--preset', preset, '--settle', '400', '--eval-file', file],
    { encoding: 'utf8', timeout: SPAWN_MS, env: { ...process.env, [RUN_ID_ENV]: runId } },
  );
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse((JSON.parse(r.stdout) as { result: string }).result) as Probe;
}

/** One launch per width, shared by every case below: the probe runs all its
 *  arms in one page, and a second launch would pay for all of them again. */
const probes = new Map<'ipad' | 'phone', Probe>();
function probeFor(preset: 'ipad' | 'phone'): Probe {
  const hit = probes.get(preset);
  if (hit) return hit;
  const got = measure(buildPage(), preset);
  probes.set(preset, got);
  return got;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const runId of owned) {
    for (const name of profilesOfRun(readdirSync(tmpdir()), runId)) {
      try {
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
      } catch {}
    }
  }
});

describe.skipIf(CHROME === null)('a comment stays with the text it marks', () => {
  for (const preset of ['ipad', 'phone'] as const) {
    const width = preset === 'ipad' ? '1180x820' : '430';
    it(
      `keeps every card with its own sentence through a meeting at ${width}`,
      () => {
        const { watching, afterScrollBack, held, jumped, untouched } = probeFor(preset);

        // THE CONTROLS. The reader really was down at the transcript, the
        // column really had cards to draw, and not one comment's sentence was
        // on screen — the three conditions the fault needs. Without them a
        // reading of zero below would mean only that nothing was measured.
        expect(watching.threads).toBeGreaterThan(0);
        expect(watching.cards).toBe(watching.threads);
        expect(watching.zoneOnScreen).toBe(true);
        expect(watching.per.every((p) => !p.anchorOnScreen)).toBe(true);

        // THE FAULT: a card painted in the visible column with its sentence
        // nowhere near it. Four of these at 1180x820 before the fix, the worst
        // 4226px from its own text; at 430 the cards sit in the flow, so the
        // reading there is the no-regression half.
        expect(watching.detached).toBe(0);
        expect(watching.worstDetachment).toBe(0);

        // The positive half of the same rule, and the control for the zero
        // above: a surface that simply stopped drawing would pass it.
        expect(afterScrollBack.beside).toBe(afterScrollBack.threads);
        expect(afterScrollBack.detached).toBe(0);
        // Beside, not merely somewhere: each card sits within a couple of card
        // heights of its text, pushed down only by its neighbours.
        for (const p of afterScrollBack.per) {
          expect(Math.abs(p.offsetFromAnchor)).toBeLessThan(400);
        }

        // And the reader parked on a comment mid-doc stays there while the
        // meeting writes under them. `scrollHeight` is the control: it says
        // the document really grew.
        expect(held.scrollHeight1).toBeGreaterThan(held.scrollHeight0);
        expect(held.beside0).toBe(true);
        expect(held.scrollTop1).toBe(held.scrollTop0);
        expect(held.anchorTop1).toBeCloseTo(held.anchorTop0, 0);
        expect(held.cardTop1).toBeCloseTo(held.cardTop0, 0);
        expect(held.beside1).toBe(true);

        // And the way BACK to a comment while the transcript is still growing
        // is the strip. The first two readings are the control: the pane was
        // at the foot and no comment's sentence was on screen, so the jump had
        // somewhere to travel from.
        expect(jumped.watchingBefore).toBe(true);
        expect(jumped.anchorsOnScreenBefore).toBe(0);
        expect(jumped.anchorOnScreen).toBe(true);
        expect(jumped.cardOnScreen).toBe(true);
        expect(Math.abs(jumped.offsetFromAnchor)).toBeLessThan(400);

        // THE PAGE NEVER FOLLOWS. The controls first: the transcript started
        // on screen, grew until its foot was past the bottom edge, and the
        // document really got taller — so a page that followed had to move.
        expect(untouched.zoneOnScreen0).toBe(true);
        expect(untouched.zoneBottomBelowFold1).toBe(true);
        expect(untouched.scrollHeight1).toBeGreaterThan(untouched.scrollHeight0);
        expect(untouched.anchorsOnScreen0).toBeGreaterThan(0);
        // It did not: the reader is where they were, beside the same comments.
        expect(untouched.scrollTop0).toBe(0);
        expect(untouched.scrollTop1).toBe(untouched.scrollTop0);
        expect(untouched.anchorsOnScreen1).toBe(untouched.anchorsOnScreen0);
        // And the words are a scroll away: down at the foot the newest one is
        // on screen, and more words arriving there do not move the page either.
        expect(untouched.handScrollTop).toBeGreaterThan(0);
        expect(untouched.newestOnScreen).toBe(true);
        expect(untouched.handScrollTop1).toBe(untouched.handScrollTop);
      },
      BROWSER_CASE_MS,
    );
  }
});

describe.skipIf(CHROME === null)('a margin comment shows only beside text on screen', () => {
  it(
    'at 1180x820 an open card whose text is just off the top paints nothing',
    () => {
      const { clamped } = probeFor('ipad');
      // THE CONTROLS. The margin is the surface here, the card's text really
      // is off screen, and the card is taller than the scroll offset — so
      // there is no room for it between the document's top and the fold,
      // which is the state the fault needs.
      expect(clamped.placement).toBe('balloon');
      expect(clamped.anchorOnScreen).toBe(false);
      expect(clamped.cardHeight).toBeGreaterThan(clamped.scrollTop);
      // THE FAULT: the column clamped the card to the document's top, and
      // 128px of it painted beside the next paragraph (cardTop -108,
      // cardBottom 128, text at -65..-25).
      expect(clamped.cardOnScreen).toBe(false);
      expect(clamped.cardBottom).toBeLessThanOrEqual(0);
      // Still reachable: the "N above" pill counts it…
      expect(clamped.hintAbove).toBeGreaterThan(0);
      // …and scrolling back brings the card back beside its text.
      expect(clamped.back?.anchorOnScreen).toBe(true);
      expect(clamped.back?.cardOnScreen).toBe(true);
      expect(Math.abs(clamped.back?.offsetFromAnchor ?? Number.NaN)).toBeLessThan(400);
    },
    BROWSER_CASE_MS,
  );

  it(
    'at 1180x820 notes landing above the comments take the cards with the text on the next frame',
    () => {
      const { landed } = probeFor('ipad');
      // THE CONTROLS. Every comment's text and card began on screen; after
      // six notes the text had moved but was still on screen; after sixteen
      // more only the title's comment was — and every card still existed.
      expect(landed.placement).toBe('balloon');
      expect(landed.before.beside).toBe(landed.before.threads);
      expect(landed.nudged.per.every((p) => p.anchorOnScreen)).toBe(true);
      expect(landed.pushed.per.filter((p) => p.anchorOnScreen)).toHaveLength(1);
      expect(landed.pushed.cards).toBe(landed.pushed.threads);
      // THE FAULT, one frame after the notes landed. The column waited out
      // its 100ms debounce first: the cards sat 374-452px above their text,
      // and once the text was pushed off the bottom, three cards painted on
      // screen beside notes they do not mark.
      expect(landed.offsetsNudged).toEqual(landed.offsetsSettled);
      expect(landed.nudged.detached).toBe(0);
      expect(landed.pushed.detached).toBe(0);
    },
    BROWSER_CASE_MS,
  );

  it(
    'at 430 there is no margin, so neither arm paints a balloon',
    () => {
      // The cards sit in the flow under their text at this width; the margin
      // rule has nothing to apply to, and the reading says so.
      const { clamped, landed } = probeFor('phone');
      expect(clamped.placement).toBe('inline');
      expect(clamped.balloonsPainted).toBe(0);
      expect(landed.placement).toBe('inline');
      expect(landed.balloonsPainted).toBe(0);
    },
    BROWSER_CASE_MS,
  );
});
