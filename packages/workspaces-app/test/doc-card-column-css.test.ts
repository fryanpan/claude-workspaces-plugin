/**
 * On a 4K screen the comment column follows the prose, not the window edge.
 *
 * The balloon margin is laid out as `minmax(0, 1fr) 260px`, so the first track
 * takes every pixel that is not the column and the prose then centres itself
 * inside it at its own 1200px measure. The wider the screen, the further the
 * cards sit from the words they are about: measured on a 3840px window, 1162px
 * of white between the last letter of a sentence and its own comment, with the
 * leader lines crossing each other to span it. The width control that used to
 * let a reader narrow the body is gone, so nothing is left to work around it.
 *
 * WHY THIS RUNS A REAL BROWSER. Every question here is a resolved grid track
 * and a measured gap. happy-dom lays nothing out (`css-harness.ts` says so),
 * and the declaration involved reads the same at every width — only the
 * rectangles say where the column ended up.
 *
 * THE CONTROL IS THE TIER BELOW. The cap is scoped to ≥1921px
 * (docs/product/design-mobile.md's 4K tier), so the same page measured at 1920
 * still shows the old, uncapped geometry. Two readings from one rule: if the
 * cap were deleted the 4K case would read like the 1920 one, and if it leaked
 * down a tier the 1920 case would read like the 4K one.
 *
 * All fixtures synthetic: Riverbend and Harborlight are place names.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RUN_ID_ENV, profilesOfRun, resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';

/** Is there a browser to launch — asked the way `ui-shot.ts` itself asks. */
const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();
const APP = join(import.meta.dirname, '..');
const SHOT = join(import.meta.dirname, '../../../scripts/ui-shot.ts');

// audit: not-source — the sheets are INSTALLED into a real browser and never
// asserted on. Every expectation below is a measured rectangle.
const read = (rel: string): string => readFileSync(join(APP, rel), 'utf8');

/** A line long enough to reach its own column's measure. */
const SENTENCE =
  'Three applicants waited on the same clerk this quarter at the Harborlight ' +
  'planning office, and two of them withdrew before the hearing was called.';

const PROBE = `(() => {
  const ed = document.getElementById('editor');
  const prose = ed.querySelector('.ProseMirror');
  const margin = ed.querySelector('.markup-margin');
  const card = margin.querySelector('.cw-balloon');
  const p = prose.getBoundingClientRect();
  const m = margin.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  return JSON.stringify({
    width: window.innerWidth,
    proseLeft: Math.round(p.left),
    proseRight: Math.round(p.right),
    proseWidth: Math.round(p.width),
    marginLeft: Math.round(m.left),
    marginWidth: Math.round(m.width),
    // The distance a leader line has to cross to reach the words.
    gapToColumn: Math.round(m.left - p.right),
    gapToCard: Math.round(c.left - p.right),
    pageScrollWidth: document.documentElement.scrollWidth,
  });
})()`;

interface Measured {
  width: number;
  proseLeft: number;
  proseRight: number;
  proseWidth: number;
  marginLeft: number;
  marginWidth: number;
  gapToColumn: number;
  gapToCard: number;
  pageScrollWidth: number;
}

/** A launch plus a load is 4-6s on this machine and vitest's default case
 *  budget is 5s, so the default loses to the load rather than to an
 *  assertion. */
const BROWSER_CASE_MS = 60_000;

const owned: string[] = [];
const dirs: string[] = [];

/**
 * The page, at `size`.
 *
 * `data-cards="balloon"` on the body is what turns the margin on: both the
 * grid and the column itself are scoped to it (`card-placement.ts` sets it
 * above 1100px), so a page without it lays out as one block and hides the
 * column — which is a layout worth nobody measuring.
 */
function measure(size: `${number}x${number}`): Measured {
  const dir = mkdtempSync(join(tmpdir(), 'cw-card-col-'));
  dirs.push(dir);
  const html = join(dir, 'margin.html');
  writeFileSync(
    html,
    `<!doctype html><html><head><meta charset="utf-8">
<style>${read('src/styles.css')}</style>
<style>${read('src/doc.css')}</style>
<style>${read('src/tokens.css')}</style>
<style>html,body{margin:0}</style>
</head><body data-cards="balloon"><div id="shell"><main id="editor-pane">
<div id="editor" class="redline-layout">
  <div class="ProseMirror"><p>${SENTENCE}</p></div>
  <div class="markup-margin"><div class="cw-balloon cw-balloon-comment">A comment</div></div>
</div></main></div></body></html>`,
  );
  const probe = join(dir, 'probe.js');
  writeFileSync(probe, PROBE);
  const runId = `cardcol${process.pid}${owned.length}`;
  owned.push(runId);
  const r = spawnSync(
    'bun',
    [SHOT, '--url', `file://${html}`, '--size', size, '--settle', '250', '--eval-file', probe],
    { encoding: 'utf8', timeout: 90_000, env: { ...process.env, [RUN_ID_ENV]: runId } },
  );
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse((JSON.parse(r.stdout) as { result: string }).result) as Measured;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const runId of owned) {
    for (const name of profilesOfRun(readdirSync(tmpdir()), runId)) {
      try {
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
      } catch {}
    }
  }
});

describe.skipIf(CHROME === null)('the comment column on a wide screen', () => {
  it(
    'sits beside the prose at 3840, not out at the window edge',
    () => {
      const m = measure('3840x2160');
      expect(m.width).toBe(3840);
      // Beside it: one gutter, the same one a laptop gets.
      expect(m.gapToColumn).toBeLessThanOrEqual(40);
      expect(m.gapToCard).toBeLessThanOrEqual(48);
      // The column is still its own full width — capped, not squeezed.
      expect(m.marginWidth).toBe(260);
      // And the prose keeps its measure and its place: the pair centres
      // exactly where the prose alone did, so nothing the reader reads moves.
      expect(m.proseWidth).toBe(1200);
      expect(m.pageScrollWidth).toBe(m.width);
    },
    BROWSER_CASE_MS,
  );

  it(
    'leaves the tier below alone — at 1920 the column is still the old distance out',
    () => {
      const m = measure('1920x1080');
      expect(m.width).toBe(1920);
      // Not capped here, so the column still rides the window edge. This is
      // the reading the 4K case used to give, and the reason it is a control.
      expect(m.gapToColumn).toBeGreaterThan(100);
      expect(m.marginWidth).toBe(260);
      expect(m.pageScrollWidth).toBe(m.width);
    },
    BROWSER_CASE_MS,
  );
});
