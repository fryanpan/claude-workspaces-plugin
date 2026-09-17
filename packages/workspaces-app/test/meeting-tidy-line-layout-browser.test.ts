/**
 * Can BOTH facts on the strip's idle line be read, on the devices they are
 * read on?
 *
 * The line a returning reader meets after a recording timed itself out now
 * carries three things at once: what ended the recording, what a tidy-up they
 * pressed did, and — when another press could answer differently — the
 * control to press it again. The strip is one row, 36px at rest, and it used
 * to carry one sentence; the question this file answers is whether all three
 * land on screen at 1180x820 and at 430 wide rather than running off the row.
 *
 * WHY A REAL BROWSER. Every claim here is used geometry — where each piece
 * actually lands once the row has wrapped — and happy-dom lays nothing out
 * (`offsetHeight` is always 0). The cascade half (which rule gives the report
 * its colour and its gap) is asserted in `meeting-strip-css.test.ts`, and the
 * pixels here, which is what testing standards 1 and 5 ask for.
 *
 * THE CONTROLS RUN IN THE SAME PAGE. Three of them. The line carrying the
 * ending's sentence ALONE still fits, so "it fits" is not a reading that
 * would pass on an empty row. Pushing the offer sideways takes it off the
 * screen, so the sampler can see the failure it reports the absence of — a
 * positive control that holds at both widths. And at 430 the same three under
 * the flowing feed's `nowrap` overflow the line, which is the specific way
 * this row could have broken narrow; at 1180 they fit on one line with room
 * to spare, so that reading discriminates nothing there and is not asserted.
 *
 * Fictional notes throughout; the repo is public.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { RUN_ID_ENV, profilesOfRun } from '../../../scripts/ui-shot-lib.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const SRC = join(import.meta.dirname, '../src');
const SHOT = join(import.meta.dirname, '../../../scripts/ui-shot.ts');

// audit: no-text — the sheets are INSTALLED into a real browser; nothing
// below asserts on their text, and every expectation is a measured pixel.
const readText = (path: string): string => readFileSync(join(SRC, path), 'utf8');

/** A launch, a profile and a CDP handshake before any page exists. */
const BROWSER_CASE_MS = 120_000;
const SPAWN_MS = 110_000;

const dirs: string[] = [];
const owned: string[] = [];

/** The sentence a timeout leaves, as `MEETING_SILENCE_NOTE` spells it. */
const ENDED = 'Recording stopped after 15 minutes without speech.';
/** The longest headline `readCleanupReply` can hand this line. */
const REPORT = 'Nothing changed — the tidy-up read the whole meeting and found nothing to improve.';

/**
 * The strip as `meeting-strip.ts` and `meeting-feed.ts` build it for that
 * line. `board.css` goes before `styles.css` and `doc.css` after it, which is
 * the link order the shell uses and the one the rules are written against.
 * `tokens.css` is left off exactly as the other browser layout test leaves it
 * off: its `:root` maps onto an Open Props subset `scripts/build.ts` prepends
 * at serve time, so inlining the file alone leaves tokens undefined.
 */
function page(opts: { report: boolean; action: boolean }): string {
  const report = opts.report
    ? `<span class="meeting-note meeting-note-report">${REPORT}</span>`
    : '';
  const action = opts.action
    ? '<button type="button" class="meeting-note-action meeting-note-tidy">Try again</button>'
    : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${readText('board.css')}</style>
<style>${readText('styles.css')}</style>
<style>${readText('doc.css')}</style>
<style>html,body{margin:0}</style>
</head><body>
<div id="meeting-strip" class="meeting-strip" data-state="idle">
  <span class="meeting-blinker" aria-hidden="true"></span>
  <span class="meeting-elapsed"></span>
  <div class="meeting-feed"><div class="meeting-feed-inner meeting-caption-line" aria-live="polite">
    <button type="button" class="meeting-note meeting-note-dismiss meeting-note-ended" title="Tap to dismiss">${ENDED}</button>${report}${action}
  </div></div>
</div>
</body></html>`;
}

/** One reading of the line. */
interface Reading {
  /** Every piece present is fully inside the viewport. */
  allOnScreen: boolean;
  /** Nothing pushed the page sideways. */
  pageOverflows: boolean;
  /** The row's own height, which grows as the line wraps. */
  stripHeight: number;
  /** The two sentences' rendered colours, to see they are told apart. */
  endedColor: string;
  reportColor: string;
  /** The report starts at or below the sentence it follows — never before it. */
  reportAfterEnded: boolean;
}

const PROBE = `(() => {
  const strip = document.querySelector('.meeting-strip');
  const line = document.querySelector('.meeting-feed-inner');
  const ended = document.querySelector('.meeting-note-ended');
  const report = document.querySelector('.meeting-note-report');
  const action = document.querySelector('.meeting-note-tidy');
  const onScreen = (el) => {
    if (!el) return true;
    const b = el.getBoundingClientRect();
    return b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth && b.height > 0;
  };
  const read = () => {
    const e = ended.getBoundingClientRect();
    const r = report ? report.getBoundingClientRect() : null;
    return {
      allOnScreen: [ended, report, action].every(onScreen),
      pageOverflows: document.documentElement.scrollWidth > innerWidth,
      stripHeight: +strip.getBoundingClientRect().height.toFixed(1),
      endedColor: getComputedStyle(ended).color,
      reportColor: report ? getComputedStyle(report).color : '',
      reportAfterEnded: r === null ? true : r.top > e.top || (r.top === e.top && r.left >= e.right),
    };
  };
  const fixed = read();
  // The control: the flowing feed's own treatment, which is what these three
  // would get if the line stopped counting as a note. It is the failure this
  // reading reports the absence of.
  line.style.whiteSpace = 'nowrap';
  document.querySelector('.meeting-feed').style.whiteSpace = 'nowrap';
  const nowrap = { lineWider: line.scrollWidth > line.clientWidth };
  line.style.removeProperty('white-space');
  document.querySelector('.meeting-feed').style.removeProperty('white-space');
  // And a piece driven off the edge: what the same reading looks like when it
  // is false, measured rather than assumed.
  const pushed = action || report;
  let offscreen = null;
  if (pushed) {
    pushed.style.marginLeft = '4000px';
    offscreen = { allOnScreen: [ended, report, action].every(onScreen) };
    pushed.style.removeProperty('margin-left');
  }
  return JSON.stringify({ fixed, nowrap, offscreen, viewport: { w: innerWidth, h: innerHeight } });
})()`;

function measure(
  preset: 'ipad' | 'phone',
  opts: { report: boolean; action: boolean },
): {
  fixed: Reading;
  nowrap: { lineWider: boolean };
  offscreen: { allOnScreen: boolean } | null;
  viewport: { w: number; h: number };
} {
  const dir = mkdtempSync(join(tmpdir(), 'cw-tidy-line-'));
  dirs.push(dir);
  const html = join(dir, 'strip.html');
  writeFileSync(html, page(opts));
  const probe = join(dir, 'probe.js');
  writeFileSync(probe, PROBE);
  const runId = `tidyline${process.pid}${owned.length}`;
  owned.push(runId);
  const r = spawnSync(
    'bun',
    [SHOT, '--url', `file://${html}`, '--preset', preset, '--settle', '200', '--eval-file', probe],
    { encoding: 'utf8', timeout: SPAWN_MS, env: { ...process.env, [RUN_ID_ENV]: runId } },
  );
  expect(r.status, r.stderr).toBe(0);
  const out = (JSON.parse(r.stdout) as { result: string }).result;
  return JSON.parse(out) as ReturnType<typeof measure>;
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

describe.skipIf(!CHROME)('the timed-out line in a real browser', () => {
  it(
    'shows the ending, the report and the offer together on the iPad',
    () => {
      const both = measure('ipad', { report: true, action: true });
      expect(both.viewport).toEqual({ w: 1180, h: 820 });
      expect(both.fixed.allOnScreen).toBe(true);
      expect(both.fixed.pageOverflows).toBe(false);
      expect(both.fixed.reportAfterEnded).toBe(true);
      // The two sentences are told apart by colour, not only by position.
      expect(both.fixed.reportColor).not.toBe(both.fixed.endedColor);
      // Control 1: the sentence alone fits too, so "it fits" is not a reading
      // taken off an empty row — and the row GREW to take the second one.
      const alone = measure('ipad', { report: false, action: false });
      expect(alone.fixed.allOnScreen).toBe(true);
      expect(both.fixed.stripHeight).toBeGreaterThanOrEqual(alone.fixed.stripHeight);
      // Control 2: the sampler sees a piece that is NOT on screen — the same
      // reading goes false the moment the offer is pushed off the edge.
      expect(both.offscreen?.allOnScreen).toBe(false);
    },
    BROWSER_CASE_MS,
  );

  it(
    'keeps all three on screen at 430 wide, where every sentence wraps',
    () => {
      const both = measure('phone', { report: true, action: true });
      expect(both.viewport.w).toBe(430);
      expect(both.fixed.allOnScreen).toBe(true);
      expect(both.fixed.pageOverflows).toBe(false);
      expect(both.fixed.reportAfterEnded).toBe(true);
      // Wrapping is the mechanism, so the row is taller than the 36px rest
      // height rather than clipping what does not fit.
      expect(both.fixed.stripHeight).toBeGreaterThan(36);
      expect(both.offscreen?.allOnScreen).toBe(false);
      // And the narrow-specific control: without the wrapping these three
      // would be wider than the line they sit on.
      expect(both.nowrap.lineWider).toBe(true);
    },
    BROWSER_CASE_MS,
  );
});
