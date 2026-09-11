/**
 * A comment sits in the margin beside the text it marks, and nowhere else —
 * measured with a meeting running under it.
 *
 * THE FAULT. A live transcript grows at the foot of the doc and follow mode
 * holds the pane there, so every comment's sentence is a screenful or more
 * above the fold. The column then drew all of them anyway: `foldWithStrips`
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
 * scrolled the pane, would report zero and prove nothing. `zoneOnScreen` and
 * `bandTop` say the meeting really pinned the pane and the strip really
 * covered the column — the two conditions the fault needs.
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
        const { following, afterScrollBack, held, jumped } = measure(buildPage(), preset);

        // THE CONTROLS. The meeting really ran the pane down to the foot, the
        // column really had cards to draw, and not one comment's sentence was
        // on screen — the three conditions the fault needs. Without them a
        // reading of zero below would mean only that nothing was measured.
        expect(following.threads).toBeGreaterThan(0);
        expect(following.cards).toBe(following.threads);
        expect(following.zoneOnScreen).toBe(true);
        expect(following.per.every((p) => !p.anchorOnScreen)).toBe(true);

        // THE FAULT: a card painted in the visible column with its sentence
        // nowhere near it. Four of these at 1180x820 before the fix, the worst
        // 4226px from its own text; at 430 the cards sit in the flow, so the
        // reading there is the no-regression half.
        expect(following.detached).toBe(0);
        expect(following.worstDetachment).toBe(0);

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
        expect(jumped.followingBefore).toBe(true);
        expect(jumped.anchorsOnScreenBefore).toBe(0);
        expect(jumped.anchorOnScreen).toBe(true);
        expect(jumped.cardOnScreen).toBe(true);
        expect(Math.abs(jumped.offsetFromAnchor)).toBeLessThan(400);
      },
      BROWSER_CASE_MS,
    );
  }
});
