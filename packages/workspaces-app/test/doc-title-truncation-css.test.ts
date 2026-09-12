/**
 * The meeting's name reads on a phone, and is cut at its END when it must be.
 *
 * Bryan's report was that the top bar at 430 showed him a few characters of a
 * name and a row of buttons he never used. Two things did that. The renderer
 * capped a phone label at 32 characters with the ellipsis at the FRONT, which
 * is right for a file name and destroys a title — the words that say which
 * meeting it is are at the start. And the toolbar beside the crumb held six
 * controls, so the crumb was pressed toward its 112px floor and the stylesheet
 * cut what was left to almost nothing.
 *
 * WHY THIS RUNS A REAL BROWSER. Every question here is a used width and a
 * rendered overflow: how much of the name the crumb gets, and where the
 * ellipsis falls. happy-dom resolves no layout (`css-harness.ts` says so), so
 * a computed-style read cannot answer either — the declarations involved read
 * the same at every width. Only a measured rectangle can.
 *
 * THE CASE CARRIES ITS OWN CONTROL. After measuring, the probe puts six
 * controls back in the toolbar — the bar as it stood before this branch — and
 * measures the same name again. The name loses most of its width, which is
 * what keeps the assertions above from being a statement about nothing.
 *
 * All fixtures synthetic: Riverbend and Harborlight are place names.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RUN_ID_ENV, profilesOfRun, resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import { mobileLabel } from '../src/review-chrome.ts';

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

// audit: not-source — the sheets and the shell's own markup are INSTALLED
// into a real browser and never asserted on. Every expectation below is a
// measured rectangle or a rendered overflow.
const read = (rel: string): string => readFileSync(join(APP, rel), 'utf8');

/** The real top bar, lifted out of the shell rather than retyped — a copy
 *  would stop being the bar the moment somebody changed the bar. */
function topbar(): string {
  const html = read('index.html');
  const open = html.indexOf('<header id="topbar">');
  const close = html.indexOf('</header>', open);
  if (open < 0 || close < 0) throw new Error('no #topbar in index.html');
  return html.slice(open, close + '</header>'.length);
}

/** A meeting's name, the length Bryan's actually run to. The words that
 *  identify it are at the FRONT, which is the whole point. */
const LONG_TITLE = 'Riverbend permit review with the Harborlight planning office';

const PROBE = `(() => {
  const bar = document.getElementById('topbar');
  const toolbar = bar.querySelector('.toolbar');
  const title = document.getElementById('doc-title');
  const crumb = bar.querySelector('.doc-crumb');
  title.textContent = ${JSON.stringify(mobileLabel(LONG_TITLE))};
  // What the renderer sets for a name rather than a path.
  title.dir = 'ltr';

  const reading = () => {
    const r = title.getBoundingClientRect();
    const cs = getComputedStyle(title);
    return {
      titleWidth: Math.round(r.width),
      titleRight: Math.round(r.right),
      crumbWidth: Math.round(crumb.getBoundingClientRect().width),
      // Wider content than box = the stylesheet is cutting it.
      overflows: title.scrollWidth > title.clientWidth,
      textOverflow: cs.textOverflow,
      direction: cs.direction,
      pageScrollWidth: document.documentElement.scrollWidth,
    };
  };

  const out = { width: window.innerWidth, shown: title.textContent, now: reading() };

  // THE CONTROL: the bar as it stood before this branch — six more controls
  // in the toolbar, competing with the crumb for the same row.
  for (let i = 0; i < 6; i++) {
    const filler = document.createElement('button');
    filler.type = 'button';
    filler.className = 'icon-btn';
    filler.textContent = 'A';
    toolbar.append(filler);
  }
  out.before = reading();
  return JSON.stringify(out);
})()`;

interface Reading {
  titleWidth: number;
  titleRight: number;
  crumbWidth: number;
  overflows: boolean;
  textOverflow: string;
  direction: string;
  pageScrollWidth: number;
}
interface Measured {
  width: number;
  shown: string;
  now: Reading;
  before: Reading;
}

/** A launch plus a load is 4-6s on this machine and vitest's default case
 *  budget is 5s, so the default loses to the load rather than to an
 *  assertion. */
const BROWSER_CASE_MS = 60_000;

const owned: string[] = [];
const dirs: string[] = [];

function measure(preset: 'ipad' | 'phone'): Measured {
  const dir = mkdtempSync(join(tmpdir(), 'cw-doc-title-'));
  dirs.push(dir);
  const html = join(dir, 'topbar.html');
  writeFileSync(
    html,
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<style>${read('src/styles.css')}</style>
<style>${read('src/doc.css')}</style>
<style>${read('src/tokens.css')}</style>
<style>html,body{margin:0}</style>
</head><body><div id="shell">${topbar()}</div></body></html>`,
  );
  const probe = join(dir, 'probe.js');
  writeFileSync(probe, PROBE);
  const runId = `doctitle${process.pid}${owned.length}`;
  owned.push(runId);
  const r = spawnSync(
    'bun',
    [SHOT, '--url', `file://${html}`, '--preset', preset, '--settle', '250', '--eval-file', probe],
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

describe('the label the renderer hands a phone', () => {
  it('leaves a name whole, so the stylesheet decides where it is cut', () => {
    expect(mobileLabel(LONG_TITLE)).toBe(LONG_TITLE);
  });

  it('still gives a path its file name, tail first, so the extension survives', () => {
    expect(mobileLabel('docs/notes/riverbend.md')).toBe('riverbend.md');
    expect(mobileLabel(`docs/${'a'.repeat(40)}-riverbend-report.md`)).toBe(
      `…${`${'a'.repeat(40)}-riverbend-report.md`.slice(-31)}`,
    );
  });
});

describe.skipIf(CHROME === null)("the meeting's name at 430", () => {
  it(
    'reads, is cut at its end, and never down to a few characters',
    () => {
      const m = measure('phone');
      expect(m.width).toBe(430);
      // The renderer handed the browser the whole name.
      expect(m.shown).toBe(LONG_TITLE);

      // It does not fit, and the stylesheet is what cuts it.
      expect(m.now.overflows).toBe(true);
      expect(m.now.textOverflow).toBe('ellipsis');
      // Cut at the END: `direction: ltr` is what puts the ellipsis there, and
      // the rtl trick that keeps a PATH's file name would put it at the front
      // of a name instead.
      expect(m.now.direction).toBe('ltr');

      // Enough of it to know which meeting this is. 112px is the crumb's own
      // floor and would be about eight characters of this face; the bar has
      // far more than that to give now.
      expect(m.now.titleWidth).toBeGreaterThanOrEqual(150);

      // Still inside the window, and the page does not scroll sideways.
      expect(m.now.titleRight).toBeLessThanOrEqual(m.width);
      expect(m.now.pageScrollWidth).toBe(m.width);

      // THE CONTROL: refill the toolbar the way it was before this branch and
      // the same name loses most of its width to the buttons.
      expect(m.before.titleWidth).toBeLessThan(m.now.titleWidth - 60);
    },
    BROWSER_CASE_MS,
  );

  it(
    'reads at 1180x820 too, where the bar has room to spare',
    () => {
      const m = measure('ipad');
      expect(m.width).toBe(1180);
      expect(m.now.titleRight).toBeLessThanOrEqual(m.width);
      expect(m.now.pageScrollWidth).toBe(m.width);
      // Nothing is cut at this width: the whole name is on screen.
      expect(m.now.overflows).toBe(false);
    },
    BROWSER_CASE_MS,
  );
});
