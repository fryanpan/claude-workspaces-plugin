/**
 * The listening banner is a row above the scroller, so it covers no line of
 * the doc it stands over — least of all a line of the live transcript.
 *
 * IT USED TO. `.lead-banner` was `position: sticky; top: 0` inside `#editor`,
 * which is the scroller, so it stayed on screen by lying on top of whatever
 * scrolled under it. On a meeting doc that is the live transcript, and at
 * maximum scroll it sat over seven of its line boxes at 430x560 and five at
 * 430x932 — measured against 1c7bcf00. The trigger is transcript length, not
 * viewport height: a transcript short enough to leave the top of the pane to
 * the prose covered nothing at either height.
 *
 * WHY A REAL BROWSER. The fault is used geometry — which painted line ends up
 * behind an overlay once the scroller is at its limit — and happy-dom lays
 * nothing out (`css-harness.ts` says so). So the pixels are read here, and
 * where the element LANDS — the other half of the same change — is asserted
 * in `lead-banner.test.ts`, which needs no browser.
 *
 * WHAT "COVERED" MEANS HERE, and it is the whole of why this test is honest.
 * A line's own rect is not evidence: an element scrolled above the top of the
 * scroller still reports a rect up there, clipped away and painted nowhere.
 * So every line is intersected with the scroller's visible box FIRST, and only
 * that remainder is tested against the banner. Which makes a zero easy to
 * reach vacuously — a page with no transcript on screen scores zero — so the
 * same reading carries two controls. `inBannerBand` counts the lines visible
 * in the top strip of the scroller that a sticky banner WOULD have covered —
 * a `covered` of zero is only evidence while that is above zero. And the
 * PRE-FIX ARRANGEMENT IS REBUILT IN THE SAME PAGE, the way the runway's own
 * control is (`meeting-phone-layout-browser.test.ts`): the line goes back
 * inside the scroller wearing the declarations it used to carry, and that
 * reading has to cover lines. A sampler that measured nothing fails there
 * rather than passing everything else vacuously.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RUN_ID_ENV, profilesOfRun, resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import { OPEN_PROPS_FILES } from '../src/tokens-manifest.ts';

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

// audit: not-source — the sheets are INSTALLED into a real browser and every
// expectation below is a measured pixel; nothing asserts on their text.
const readText = (path: string): string => readFileSync(path, 'utf8');

/**
 * `/app/tokens.css` as the server serves it: the vendored Open Props files
 * FIRST, then the mapping in `src/tokens.css` — the order `scripts/build.ts`
 * concatenates them in. The mapping alone resolves every token to the
 * invalid initial value, so a page that inlined it would paint this banner
 * with no panel and no border and still look plausible in a screenshot.
 * Colour decides nothing measured below; it decides whether a shot of this
 * page is a picture of the app.
 */
function servedTokens(): string {
  const fromPkg = createRequire(join(import.meta.dirname, '../package.json'));
  return [
    ...OPEN_PROPS_FILES.map((f) => readText(fromPkg.resolve(`open-props/${f}`))),
    readText(join(SRC, 'tokens.css')),
  ].join('\n');
}

/** A launch, a profile and a CDP handshake before any page exists. */
const BROWSER_CASE_MS = 120_000;
const SPAWN_MS = 110_000;

const dirs: string[] = [];
const owned: string[] = [];

/**
 * A huddle doc mid-meeting with nobody in the lead seat: the banner, a doc
 * long enough to scroll, and a transcript long enough to fill the pane at
 * maximum scroll — which is the state the banner was covering.
 */
function page(): string {
  const prose = Array.from(
    { length: 24 },
    (_, i) =>
      `<li>Riverbend needs two more boats before the thaw, either way we should decide soon — ${i + 1}.</li>`,
  ).join('');
  // Long enough to fill the pane at the WIDEST viewport too: at 1180 the
  // lines are nearly three times as wide, and a transcript that filled a
  // phone left the top of that pane to the prose — which took the control
  // below to zero for the right reason and made the case prove nothing.
  const turns = Array.from(
    { length: 60 },
    (_, i) =>
      `<span class="lz-turn">Harborlight wants the draft timetable before the board meets again, and Saltmarsh covers the second week if the tide allows — ${i + 1}.</span> `,
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<style>${readText(join(SRC, 'styles.css'))}</style>
<style>${readText(join(SRC, 'doc.css'))}</style>
<style>${servedTokens()}</style>
<style>html,body{margin:0}</style>
</head><body>
<div id="shell"><main id="main">
<section id="editor-pane">
  <div class="meeting-strip is-live" data-state="recording">
    <span class="meeting-blinker"></span><span class="meeting-elapsed">00:41</span>
    <div class="meeting-feed"><div class="meeting-feed-inner meeting-caption-line">
      <span class="meeting-turn">the slipway quote came back under budget</span>
    </div></div>
  </div>
  <div class="lead-banner" role="status">
    <span class="lead-banner__dot" aria-hidden="true"></span>
    <span class="lead-banner__text">No lead agent is listening — asks made here will queue until one attaches.</span>
  </div>
  <div id="editor">
    <div class="ProseMirror"><h1>Survey planning</h1><ul>${prose}</ul></div>
    <div class="live-zone">
      <div class="lz-head"><span class="lz-label">Live transcript</span></div>
      <div class="lz-lines">${turns}</div>
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
</body></html>`;
}

function buildPage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-lead-banner-'));
  dirs.push(dir);
  const html = join(dir, 'meeting.html');
  writeFileSync(html, page());
  return html;
}

/** One reading, taken at maximum scroll. */
interface Reading {
  /** The banner is on screen and has a height worth clearing. */
  bannerHeight: number;
  /** Lines of the doc VISIBLE in the scroller and overlapping the banner. */
  covered: number;
  /** Lines visible in the top strip of the scroller — the band a sticky
   *  banner occupied. The positive control: a zero `covered` proves nothing
   *  unless this is above zero. */
  inBannerBand: number;
  /** The banner ends at or above where the scroller begins. */
  bannerBottom: number;
  scrollerTop: number;
  /** Nothing left to scroll when the reading was taken. */
  scrollRemaining: number;
  /** The scroller's own box, to price the row against. */
  scrollerHeight: number;
}

/** The pre-fix arrangement's own reading — the bug, rebuilt in this page. */
interface Control {
  covered: number;
}

/** What the row costs a doc that has nothing to say — which must be nothing. */
interface Cost {
  bannerHeight: number;
  shownTop: number;
  shownHeight: number;
  hiddenTop: number;
  hiddenHeight: number;
}

const PROBE = `(() => {
  const ed = document.querySelector('#editor');
  const banner = document.querySelector('.lead-banner');
  // Every painted line box of the thing under the banner, clipped to what the
  // scroller actually shows — see the header for why the clip is the point.
  const visibleLines = (root) => {
    const view = ed.getBoundingClientRect();
    const out = [];
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if ((el.textContent || '').trim().length === 0) continue;
      for (const b of el.getClientRects()) {
        if (b.height <= 0) continue;
        const top = Math.max(b.top, view.top);
        const bottom = Math.min(b.bottom, view.bottom);
        if (bottom > top) out.push({ top, bottom });
      }
    }
    return out;
  };
  const overlaps = (lines, top, bottom) =>
    lines.filter((l) => l.top < bottom && l.bottom > top).length;
  const read = (root) => {
    ed.scrollTop = ed.scrollHeight;
    const lines = visibleLines(root);
    const bn = banner.getBoundingClientRect();
    const view = ed.getBoundingClientRect();
    return {
      bannerHeight: +bn.height.toFixed(1),
      covered: overlaps(lines, bn.top, bn.bottom),
      inBannerBand: overlaps(lines, view.top, view.top + bn.height),
      bannerBottom: +bn.bottom.toFixed(1),
      scrollerTop: +view.top.toFixed(1),
      scrollRemaining: Math.round(ed.scrollHeight - ed.clientHeight - ed.scrollTop),
      scrollerHeight: +view.height.toFixed(1),
    };
  };
  // What the row costs a doc whose lead IS listening: the banner goes
  // hidden, and the scroller must take back exactly the height it gave up —
  // no reserved inset standing empty on every other doc in the app.
  const cost = () => {
    const shown = ed.getBoundingClientRect();
    const bn = banner.getBoundingClientRect();
    banner.hidden = true;
    const off = ed.getBoundingClientRect();
    banner.hidden = false;
    return {
      bannerHeight: +bn.height.toFixed(1),
      shownTop: +shown.top.toFixed(1),
      shownHeight: +shown.height.toFixed(1),
      hiddenTop: +off.top.toFixed(1),
      hiddenHeight: +off.height.toFixed(1),
    };
  };
  // THE BUG, REBUILT HERE. Back inside the scroller as its first child,
  // wearing what \`.lead-banner\` used to declare — sticky to the top of the
  // scroller, pulled up over the prose's first line by a negative margin.
  // Nothing else about the page changes, so a \`covered\` of zero above is
  // this arrangement having gone, not the page having nothing to cover.
  const preFix = () => {
    const copy = banner.cloneNode(true);
    copy.style.cssText =
      'position:sticky;top:0;z-index:3;margin:-8px 0 16px;border-radius:10px;' +
      'background:var(--panel-bg, var(--bg));box-shadow:0 1px 2px rgba(0,0,0,0.08)';
    banner.hidden = true;
    ed.prepend(copy);
    const view = ed.getBoundingClientRect();
    ed.scrollTop = ed.scrollHeight;
    const bn = copy.getBoundingClientRect();
    const lines = [];
    for (const el of [zoneEl, ...zoneEl.querySelectorAll('*')]) {
      if ((el.textContent || '').trim().length === 0) continue;
      for (const b of el.getClientRects()) {
        if (b.height <= 0) continue;
        const top = Math.max(b.top, view.top);
        const bottom = Math.min(b.bottom, view.bottom);
        if (bottom > top) lines.push({ top, bottom });
      }
    }
    const covered = lines.filter((l) => l.top < bn.bottom && l.bottom > bn.top).length;
    copy.remove();
    banner.hidden = false;
    return { covered };
  };

  const zoneEl = document.querySelector('.live-zone');
  const control = preFix();
  const zone = read(zoneEl);
  // The same doc with no meeting on it — hiding the zone is what the app's
  // own selectors read, so this is an ordinary prose doc's layout. The banner
  // has to clear the PROSE too, and that is the case a meeting test would
  // never open.
  zoneEl.hidden = true;
  const proseOnly = read(document.querySelector('#editor > .ProseMirror'));
  zoneEl.hidden = false;
  return JSON.stringify({ zone, proseOnly, cost: cost(), control });
})()`;

function measure(
  html: string,
  size: string,
): { zone: Reading; proseOnly: Reading; cost: Cost; control: Control } {
  const dir = mkdtempSync(join(tmpdir(), 'cw-lead-banner-probe-'));
  dirs.push(dir);
  const file = join(dir, 'probe.js');
  writeFileSync(file, PROBE);
  const runId = `leadbanner${process.pid}${owned.length}`;
  owned.push(runId);
  const r = spawnSync(
    'bun',
    [SHOT, '--url', `file://${html}`, '--size', size, '--settle', '200', '--eval-file', file],
    { encoding: 'utf8', timeout: SPAWN_MS, env: { ...process.env, [RUN_ID_ENV]: runId } },
  );
  expect(r.status, r.stderr).toBe(0);
  const out = (JSON.parse(r.stdout) as { result: string }).result;
  return JSON.parse(out) as { zone: Reading; proseOnly: Reading; cost: Cost; control: Control };
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

/** The three widths design-mobile.md asks for, plus the short phone that is
 *  where these surfaces have failed before. */
const SIZES = ['430x560', '430x932', '1180x820'] as const;

describe.skipIf(!CHROME)('the listening banner, in a real browser', () => {
  for (const size of SIZES) {
    it(
      `covers no line of the transcript or the prose at ${size}`,
      () => {
        const { zone, proseOnly, cost, control } = measure(buildPage(), size);
        for (const [what, r] of [
          ['transcript', zone],
          ['prose', proseOnly],
        ] as const) {
          // The banner is really there — a reading off a hidden banner would
          // score zero for the wrong reason.
          expect(r.bannerHeight, what).toBeGreaterThan(0);
          // …and the scroller had run out, which is where the fault lived.
          expect(r.scrollRemaining, what).toBe(0);
          // The control: lines ARE visible in the strip a sticky banner held,
          // so a zero below is the banner having moved, not the page being
          // empty there.
          expect(r.inBannerBand, what).toBeGreaterThan(0);
          // The done-when.
          expect(r.covered, what).toBe(0);
        }
        // The bug, rebuilt in the same page: sticky inside the scroller, it
        // does cover the transcript. Without this a zero above is not news.
        expect(control.covered).toBeGreaterThan(0);
        // And the reason it covers nothing: it ends where the scroller begins.
        expect(zone.bannerBottom).toBeLessThanOrEqual(zone.scrollerTop);
        // The row is paid for only while it has something to say: a doc
        // whose lead IS listening gets every pixel of it back.
        expect(cost.bannerHeight).toBeGreaterThan(0);
        // `toBeCloseTo` for the subpixel only: these are three fractional
        // CSS pixels summed, not a tolerance on the claim.
        expect(cost.hiddenTop).toBeCloseTo(cost.shownTop - cost.bannerHeight, 1);
        expect(cost.hiddenHeight).toBeCloseTo(cost.shownHeight + cost.bannerHeight, 1);
      },
      BROWSER_CASE_MS,
    );
  }
});
