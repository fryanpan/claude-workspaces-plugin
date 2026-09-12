/**
 * The geometry half of the phone meeting layout: at maximum scroll, does the
 * live transcript actually clear Make Plan and Review?
 *
 * Bryan held a meeting on his phone on 2026-09-11 and could not read the end
 * of the transcript: "it collides with them and will not scroll up". The
 * floats are pinned to `#editor-pane` and the scroller ended eight pixels
 * under the last word, so the bottom of the transcript sat behind two 71px
 * pills with nothing left to scroll.
 *
 * WHY A REAL BROWSER. The fix is a padding built from `calc()` and `max()`,
 * and the symptom is used geometry — where the last painted line ends once the
 * scroller is at its limit. happy-dom lays nothing out and drops the whole
 * declaration (`css-harness.ts` says so), so the cascade half is asserted
 * there (`meeting-phone-layout-css.test.ts`) and the pixels here, which is
 * what testing standards 1 and 5 ask for.
 *
 * THE CONTROL RUNS IN THE SAME PAGE. `--lz-runway: 0px` written inline on the
 * scroller rebuilds the pre-fix padding exactly, so a reading in which the
 * sampler measured nothing fails there rather than passing everything else
 * vacuously.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RUN_ID_ENV, profilesOfRun, resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';

/** Is there a browser to launch — asked the way `ui-shot.ts` asks, so a CI
 *  runner that names no path still finds its own Chrome. */
const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();

const SRC = join(import.meta.dirname, '../src');
const SHOT = join(import.meta.dirname, '../../../scripts/ui-shot.ts');

// audit: not-source — the sheets are INSTALLED into a real browser; nothing
// below asserts on their text, and every expectation is a measured pixel.
const readText = (path: string): string => readFileSync(path, 'utf8');

/** A launch, a profile and a CDP handshake before any page exists. */
const BROWSER_CASE_MS = 120_000;
const SPAWN_MS = 110_000;

const dirs: string[] = [];
const owned: string[] = [];

/** Enough prose to make the scroller scroll, then the live transcript. */
function page(): string {
  const paragraphs = Array.from(
    { length: 24 },
    (_, i) =>
      `<li>Riverbend needs two more boats before the thaw, either way we should decide soon — ${i + 1}.</li>`,
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<style>${readText(join(SRC, 'styles.css'))}</style>
<style>${readText(join(SRC, 'doc.css'))}</style>
<style>${readText(join(SRC, 'tokens.css'))}</style>
<style>html,body{margin:0}#editor-pane{height:100vh}</style>
</head><body>
<div id="shell"><main id="main">
<section id="editor-pane">
  <div class="meeting-strip is-live" data-state="recording">
    <span class="meeting-blinker"></span><span class="meeting-elapsed">00:41</span>
    <div class="meeting-feed"><div class="meeting-feed-inner meeting-caption-line">
      <span class="meeting-turn">the slipway quote came back under budget</span>
    </div></div>
  </div>
  <div id="editor">
    <div class="ProseMirror"><h1>Survey planning</h1><ul>${paragraphs}</ul></div>
    <div class="live-zone">
      <div class="lz-head"><span class="lz-label">Live transcript</span></div>
      <div class="lz-lines"><span class="lz-turn">Harborlight wants the draft timetable before the board meets again, and Saltmarsh covers the second week and the week after that if the tide allows it at all.</span></div>
    </div>
  </div>
  <div class="doc-floats">
    <button type="button" class="plan-float plan-float--make">
      <span class="plan-float-label">Make Plan</span>
      <span class="plan-float-sub">Ask your agent to create a plan</span>
    </button>
    <button type="button" class="plan-float review-float review-float--ask">
      <span class="plan-float-label">Review</span>
      <span class="plan-float-sub">Ask your agent to review the notes</span>
    </button>
  </div>
</section>
</main></div>
<button type="button" class="meeting-record is-live" id="rec">
  <span class="meeting-record-dot"></span><span class="meeting-record-label">Recording</span>
</button>
</body></html>`;
}

function buildPage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-phone-meeting-'));
  dirs.push(dir);
  const html = join(dir, 'meeting.html');
  writeFileSync(html, page());
  return html;
}

/** One measurement, taken at maximum scroll, with and without the runway. */
interface Reading {
  /** Editor padding-bottom as the browser resolved it. */
  padBottom: string;
  /** Lowest painted bottom of anything inside the live zone. */
  transcriptBottom: number;
  /** Top of the float dock. */
  dockTop: number;
  /** Pixels of transcript at or below the dock's top edge. Negative = clear. */
  behind: number;
  /** Nothing left to scroll when the reading was taken. */
  scrollRemaining: number;
  stripDisplay: string;
  stripHeight: number;
  dotAnimation: string;
  floatHeights: number[];
  subtitleHeights: number[];
}

const PROBE = `(() => {
  const ed = document.querySelector('#editor');
  const dock = document.querySelector('.doc-floats');
  const zone = document.querySelector('.live-zone');
  const strip = document.querySelector('.meeting-strip');
  const dot = document.querySelector('.meeting-record-dot');
  const read = () => {
    ed.scrollTop = ed.scrollHeight;
    let bottom = -Infinity;
    for (const el of [zone, ...zone.querySelectorAll('*')]) {
      if ((el.textContent || '').trim().length === 0) continue;
      for (const b of el.getClientRects()) if (b.height > 0 && b.bottom > bottom) bottom = b.bottom;
    }
    const dockTop = dock.getBoundingClientRect().top;
    const floats = [...document.querySelectorAll('.plan-float')];
    return {
      padBottom: getComputedStyle(ed).paddingBottom,
      transcriptBottom: +bottom.toFixed(1),
      dockTop: +dockTop.toFixed(1),
      behind: +(bottom - dockTop).toFixed(1),
      scrollRemaining: Math.round(ed.scrollHeight - ed.clientHeight - ed.scrollTop),
      stripDisplay: getComputedStyle(strip).display,
      stripHeight: +strip.getBoundingClientRect().height.toFixed(1),
      dotAnimation: getComputedStyle(dot).animationName,
      floatHeights: floats.map((f) => +f.getBoundingClientRect().height.toFixed(1)),
      subtitleHeights: floats.map(
        (f) => +f.querySelector('.plan-float-sub').getBoundingClientRect().height.toFixed(1),
      ),
    };
  };
  const fixed = read();
  // The control: the pre-fix padding, rebuilt on the same page.
  ed.style.setProperty('--lz-runway', '0px');
  const control = read();
  ed.style.removeProperty('--lz-runway');
  // And the dock seated in the balloon margin (new-indicator.ts), where it
  // covers no prose and the transcript must keep the padding it always had.
  dock.classList.add('is-floating');
  const floating = read();
  dock.classList.remove('is-floating');
  return JSON.stringify({ fixed, control, floating });
})()`;

function measure(
  html: string,
  preset: 'ipad' | 'phone',
): { fixed: Reading; control: Reading; floating: Reading } {
  const dir = mkdtempSync(join(tmpdir(), 'cw-phone-meeting-probe-'));
  dirs.push(dir);
  const file = join(dir, 'probe.js');
  writeFileSync(file, PROBE);
  const runId = `phonemeeting${process.pid}${owned.length}`;
  owned.push(runId);
  const r = spawnSync(
    'bun',
    [SHOT, '--url', `file://${html}`, '--preset', preset, '--settle', '200', '--eval-file', file],
    { encoding: 'utf8', timeout: SPAWN_MS, env: { ...process.env, [RUN_ID_ENV]: runId } },
  );
  expect(r.status, r.stderr).toBe(0);
  const out = (JSON.parse(r.stdout) as { result: string }).result;
  return JSON.parse(out) as { fixed: Reading; control: Reading; floating: Reading };
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  const tmp = tmpdir();
  for (const runId of owned) {
    for (const name of profilesOfRun(readdirSync(tmp), runId)) {
      rmSync(join(tmp, name), { recursive: true, force: true });
    }
  }
});

describe.skipIf(!CHROME)('the meeting page at 430, in a real browser', () => {
  it(
    'the transcript scrolls clear of Make Plan and Review — and collides again without the runway',
    () => {
      const { fixed, control } = measure(buildPage(), 'phone');
      // Done-when 1: at maximum scroll the transcript ends ABOVE the buttons.
      expect(fixed.scrollRemaining).toBe(0);
      expect(fixed.behind).toBeLessThan(0);
      // The control is the bug: the same page with the runway taken away ends
      // with the transcript at or below the buttons' top edge.
      expect(control.scrollRemaining).toBe(0);
      expect(control.behind).toBeGreaterThan(0);

      // Done-when 2: no bar under the recording bar, and the indicator that is
      // left blinks in the top right.
      expect(fixed.stripDisplay).toBe('none');
      expect(fixed.stripHeight).toBe(0);
      expect(fixed.dotAnimation).toBe('meeting-blink');

      // Done-when 3: one short line each, no subtitles.
      for (const h of fixed.floatHeights) expect(h).toBeLessThanOrEqual(48);
      for (const h of fixed.subtitleHeights) expect(h).toBe(0);
    },
    BROWSER_CASE_MS,
  );
});

describe.skipIf(!CHROME)('the meeting page at 1180x820, in a real browser', () => {
  it(
    'is untouched: the strip, the two-line floats and the transcript’s own padding',
    () => {
      const { fixed, floating } = measure(buildPage(), 'ipad');
      expect(fixed.stripDisplay).toBe('flex');
      expect(fixed.stripHeight).toBeGreaterThan(0);
      expect(fixed.dotAnimation).toBe('none');
      // Two lines, and taller than the phone's 44px pill.
      for (const h of fixed.floatHeights) expect(h).toBeGreaterThan(48);
      for (const h of fixed.subtitleHeights) expect(h).toBeGreaterThan(0);
      // A dock seated in the balloon margin covers no prose, so the
      // transcript keeps exactly the padding it had before this change.
      expect(floating.padBottom).toBe('8px');
      // …and the reading is only evidence because the same page WITHOUT that
      // seat does reserve the runway.
      expect(fixed.padBottom).toBe('112px');
    },
    BROWSER_CASE_MS,
  );
});
