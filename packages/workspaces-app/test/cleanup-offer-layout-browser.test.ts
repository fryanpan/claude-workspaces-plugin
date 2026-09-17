/**
 * Can the tidy-up's report be READ, on the device it is read on?
 *
 * On 2026-09-16 a fresh-eyes walk of the built dialog found it could not. The
 * card had no `max-height` and the scrim was `overflow: visible`, so a report
 * of twenty rules measured 942.5px against the iPad's 820: the headline sat
 * 41.3px above the top of the screen, both answers 41.3px below the bottom of
 * it, and there was nothing to scroll to reach either. Escape and the scrim
 * still closed it, so nobody was trapped — the report simply could not be
 * read.
 *
 * WHY A REAL BROWSER. The fix is `max-height` on a flex column whose report
 * takes the slack, and the symptom is used geometry: where the headline and
 * the two answers actually land once the card has been laid out. happy-dom
 * lays nothing out (`offsetHeight` is always 0), so the cascade half of this
 * dialog is asserted in `cleanup-offer-css.test.ts` and the pixels here,
 * which is what testing standards 1 and 5 ask for.
 *
 * THE CONTROL RUNS IN THE SAME PAGE. `max-height: none` written inline on the
 * card rebuilds the pre-fix geometry exactly, so a reading in which the
 * sampler measured nothing fails there rather than passing everything else
 * vacuously.
 *
 * Fictional notes and fictional rules throughout; the repo is public.
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

// audit: not-source — the sheets are INSTALLED into a real browser; nothing
// below asserts on their text, and every expectation is a measured pixel.
const readText = (path: string): string => readFileSync(join(SRC, path), 'utf8');

/** A launch, a profile and a CDP handshake before any page exists. */
const BROWSER_CASE_MS = 120_000;
const SPAWN_MS = 110_000;

const dirs: string[] = [];
const owned: string[] = [];

/** The rules a real pass drops edits for, long enough to wrap the card. */
const RULES = [
  'the document does not record the block as the note-taker’s own',
  'somebody has commented on the block',
  'the block is not in the document',
  'the block is the meeting’s own section heading',
  'a cleanup may not open a second notes section',
];

/** The dialog as `meeting-cleanup-offer.ts` builds it, reporting `rows`
 *  rules. `tokens.css` is left off exactly as `cleanup-offer-css.test.ts`
 *  leaves it off: its `:root` maps onto an Open Props subset that
 *  `scripts/build.ts` prepends at serve time, so inlining the file alone
 *  leaves `--accent` and `--border` undefined. */
function page(rows: number): string {
  const list = Array.from(
    { length: rows },
    (_, i) => `<li>${rows - i} edits — ${RULES[i % RULES.length]}</li>`,
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${readText('styles.css')}</style>
<style>${readText('doc.css')}</style>
<style>html,body{margin:0;height:100%}</style>
</head><body>
<div class="cleanup-offer" data-phase="reported">
  <div class="cleanup-offer-card" role="dialog" aria-modal="true" aria-labelledby="cleanup-offer-title">
    <h2 id="cleanup-offer-title" class="cleanup-offer-title" aria-live="polite">Nothing changed — none of these edits could be made to the notes.</h2>
    <ul class="cleanup-offer-reasons">${list}</ul>
    <p class="cleanup-offer-recovery">Those notes are under discussion, so the tidy-up left them alone. Resolve the threads on them and run it again.</p>
    <div class="cleanup-offer-actions">
      <button type="button" class="cleanup-offer-dismiss">Close</button>
      <button type="button" class="cleanup-offer-go"><span class="voice-spinner cleanup-offer-spinner" aria-hidden="true"></span><span class="cleanup-offer-go-label">Try again</span></button>
    </div>
  </div>
</div>
</body></html>`;
}

/** One reading of the card, taken with the report scrolled to its far end —
 *  the position from which the answers are hardest to reach. */
interface Reading {
  cardHeight: number;
  headlineTop: number;
  answersBottom: number;
  /** Headline fully on screen. */
  headlineReadable: boolean;
  /** Both answers fully on screen. */
  answersReachable: boolean;
  /** The report has somewhere to scroll, and went there. */
  reportScrolled: boolean;
}

const PROBE = `(() => {
  const card = document.querySelector('.cleanup-offer-card');
  const title = document.querySelector('.cleanup-offer-title');
  const reasons = document.querySelector('.cleanup-offer-reasons');
  const answers = [...document.querySelectorAll('.cleanup-offer-actions button')];
  const onScreen = (el) => {
    const b = el.getBoundingClientRect();
    return b.top >= 0 && b.bottom <= innerHeight && b.height > 0;
  };
  const read = () => {
    // Push every scroller to its far end first: a report that CAN scroll must
    // not take the answers off the screen when it does.
    reasons.scrollTop = reasons.scrollHeight;
    card.scrollTop = card.scrollHeight;
    return {
      cardHeight: +card.getBoundingClientRect().height.toFixed(1),
      headlineTop: +title.getBoundingClientRect().top.toFixed(1),
      answersBottom: +Math.max(...answers.map((a) => a.getBoundingClientRect().bottom)).toFixed(1),
      headlineReadable: onScreen(title),
      answersReachable: answers.every(onScreen),
      reportScrolled: reasons.scrollTop > 0,
    };
  };
  const fixed = read();
  // The control: the card unbounded again, which is how this shipped.
  card.style.maxHeight = 'none';
  reasons.scrollTop = 0;
  const control = read();
  card.style.removeProperty('max-height');
  return JSON.stringify({ fixed, control, viewportHeight: innerHeight });
})()`;

function measure(
  rows: number,
  preset: 'ipad' | 'phone',
): { fixed: Reading; control: Reading; viewportHeight: number } {
  const dir = mkdtempSync(join(tmpdir(), 'cw-cleanup-offer-'));
  dirs.push(dir);
  const html = join(dir, 'offer.html');
  writeFileSync(html, page(rows));
  const probe = join(dir, 'probe.js');
  writeFileSync(probe, PROBE);
  const runId = `cleanupoffer${process.pid}${owned.length}`;
  owned.push(runId);
  const r = spawnSync(
    'bun',
    [SHOT, '--url', `file://${html}`, '--preset', preset, '--settle', '200', '--eval-file', probe],
    { encoding: 'utf8', timeout: SPAWN_MS, env: { ...process.env, [RUN_ID_ENV]: runId } },
  );
  expect(r.status, r.stderr).toBe(0);
  const out = (JSON.parse(r.stdout) as { result: string }).result;
  return JSON.parse(out) as { fixed: Reading; control: Reading; viewportHeight: number };
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

describe.skipIf(!CHROME)('the tidy-up report in a real browser', () => {
  it(
    'is readable end to end on the iPad, and runs off both edges without the cap',
    () => {
      const { fixed, control, viewportHeight } = measure(20, 'ipad');
      expect(viewportHeight).toBe(820);
      // The headline naming what happened, and both answers, are on screen —
      // from the far end of a report long enough to need scrolling.
      expect(fixed.headlineReadable).toBe(true);
      expect(fixed.answersReachable).toBe(true);
      expect(fixed.cardHeight).toBeLessThanOrEqual(viewportHeight);
      expect(fixed.reportScrolled).toBe(true);
      // The control is the bug: unbounded, the same card runs off BOTH edges
      // of the screen at once, and neither end can be scrolled to.
      expect(control.cardHeight).toBeGreaterThan(viewportHeight);
      expect(control.headlineTop).toBeLessThan(0);
      expect(control.answersBottom).toBeGreaterThan(viewportHeight);
      expect(control.headlineReadable).toBe(false);
      expect(control.answersReachable).toBe(false);
    },
    BROWSER_CASE_MS,
  );

  it(
    'is readable end to end at 430 wide, where every rule wraps',
    () => {
      const { fixed, control, viewportHeight } = measure(24, 'phone');
      expect(fixed.headlineReadable).toBe(true);
      expect(fixed.answersReachable).toBe(true);
      expect(fixed.cardHeight).toBeLessThanOrEqual(viewportHeight);
      expect(fixed.reportScrolled).toBe(true);
      expect(control.answersReachable).toBe(false);
    },
    BROWSER_CASE_MS,
  );

  it(
    'leaves a report with two rules the height of two rules',
    () => {
      // The cap must not stretch a short report down the card: `flex-grow: 0`
      // is what keeps a two-rule answer the size of its answer.
      const { fixed, viewportHeight } = measure(2, 'ipad');
      expect(fixed.headlineReadable).toBe(true);
      expect(fixed.answersReachable).toBe(true);
      expect(fixed.cardHeight).toBeLessThan(viewportHeight / 2);
      // Nothing to scroll, so nothing scrolled.
      expect(fixed.reportScrolled).toBe(false);
    },
    BROWSER_CASE_MS,
  );
});
