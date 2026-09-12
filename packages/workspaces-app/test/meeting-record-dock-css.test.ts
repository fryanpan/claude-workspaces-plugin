/**
 * The Record button is on screen on a phone, and nothing has to be scrolled
 * sideways to reach it.
 *
 * Found by a UX check at 430px: the toolbar in the top bar is a horizontal
 * SCROLL container below 1100px (styles.css's phone block grew it as the
 * escape valve so a future button could not push the doc crumb off-screen),
 * and the Record Audio button was appended to the END of it. Measured on
 * main at 430: the toolbar's content was 302px inside a 286px scrollport and
 * the options chevron's right edge landed at 434 — outside a 430px window,
 * with nothing on screen to say the bar scrolled at all.
 *
 * The fix moves Record and its chevron out of the scroll container: they
 * dock into `#topbar` itself as one rigid `.meeting-record-dock`, and the
 * toolbar beside them is the side that yields — which is what that phone
 * block already asks of it.
 *
 * WHY THIS RUNS A REAL BROWSER. The whole bug is a used-size and a scroll
 * offset. happy-dom resolves no layout at all (`css-harness.ts` says so), so
 * a computed-style read cannot see it: every declaration involved reads the
 * same whichever parent the button sits in. Only a measured rectangle can,
 * which is what testing standard 1 asks for.
 *
 * THE CASE CARRIES ITS OWN CONTROL. After measuring, the probe refills the
 * toolbar with the six controls that were taken out of it and puts the dock
 * back inside — the pre-fix arrangement, in the same page, at the same width —
 * and measures again. The slimmer bar now fits at 430 on its own, so without
 * that rebuild the real assertions would pass on a bar with room to spare;
 * the control is what keeps them meaning something.
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

// audit: not-source — the sheets and the shell's own markup are INSTALLED
// into a real browser and never asserted on. Every expectation below is a
// measured rectangle, so a renamed selector or a reworded declaration can
// neither pass nor fail a case here.
const read = (rel: string): string => readFileSync(join(APP, rel), 'utf8');

/**
 * The real top bar, lifted out of the shell rather than retyped. A copy of
 * the markup would drift the moment somebody adds a button — and a button
 * added to that toolbar is exactly the pressure this case exists under.
 */
function topbar(): string {
  const html = read('index.html');
  const open = html.indexOf('<header id="topbar">');
  const close = html.indexOf('</header>', open);
  if (open < 0 || close < 0) throw new Error('no #topbar in index.html');
  return html.slice(open, close + '</header>'.length);
}

/**
 * What the meeting mount appends, built the way `meeting-strip.ts` builds it:
 * Record and its chevron inside one dock, docked into the bar.
 */
const PROBE = `(() => {
  const bar = document.getElementById('topbar');
  const toolbar = bar.querySelector('.toolbar');
  const dock = document.createElement('div');
  dock.className = 'meeting-record-dock';
  const record = document.createElement('button');
  record.type = 'button';
  record.className = 'meeting-record';
  const glyph = document.createElement('span');
  glyph.className = 'meeting-record-glyph';
  glyph.innerHTML = '<svg viewBox="0 0 16 16"><path d="M3 6.5v3h2.6L9 12.6V3.4L5.6 6.5H3z" fill="currentColor"/></svg>';
  const label = document.createElement('span');
  label.className = 'meeting-record-label';
  label.textContent = 'Record Audio';
  record.append(glyph, label);
  const options = document.createElement('button');
  options.type = 'button';
  options.className = 'meeting-record-options';
  options.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 6.5l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>';
  dock.append(record, options);
  bar.append(dock);

  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {
      left: Math.round(r.left),
      right: Math.round(r.right),
      top: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  };
  const reading = () => ({
    dock: box(dock),
    record: box(record),
    options: box(options),
    crumb: box(bar.querySelector('.doc-crumb')),
    toolbarScrolls: toolbar.scrollWidth > toolbar.clientWidth,
    toolbarScrollLeft: Math.round(toolbar.scrollLeft),
    pageScrollWidth: document.documentElement.scrollWidth,
  });

  const out = { width: window.innerWidth, docked: reading() };
  // The strip hides the chevron while a meeting runs by setting the hidden
  // attribute. Whether that HIDES it is a cascade question: an author display
  // on the class out-specifies the UA's rule for it, and for a while it did.
  out.chevronShown = getComputedStyle(options).display;
  options.hidden = true;
  out.chevronHidden = getComputedStyle(options).display;
  options.hidden = false;

  // The control: the bar as it stood BEFORE this branch, same page, same
  // width — the six controls that came out of the toolbar put back, and the
  // pair appended to the end of that scroll container where it used to live.
  // The slimmer bar fits on its own now, so without this the assertions above
  // would pass on a bar with room to spare and prove nothing about the dock.
  for (let i = 0; i < 6; i++) {
    const filler = document.createElement('button');
    filler.type = 'button';
    filler.className = 'icon-btn';
    filler.textContent = 'A';
    toolbar.append(filler);
  }
  toolbar.append(dock);
  out.inToolbar = reading();
  return JSON.stringify(out);
})()`;

interface Box {
  left: number;
  right: number;
  top: number;
  width: number;
  height: number;
}
interface Reading {
  dock: Box;
  record: Box;
  options: Box;
  crumb: Box;
  toolbarScrolls: boolean;
  toolbarScrollLeft: number;
  pageScrollWidth: number;
}
interface Measured {
  width: number;
  chevronShown: string;
  chevronHidden: string;
  docked: Reading;
  inToolbar: Reading;
}

/**
 * A launch plus a load is 4-6s on this machine and vitest's default case
 * budget is 5s, so the default loses to the load rather than to an assertion.
 */
const BROWSER_CASE_MS = 60_000;

const owned: string[] = [];
const dirs: string[] = [];

function measure(preset: 'ipad' | 'phone'): Measured {
  const dir = mkdtempSync(join(tmpdir(), 'cw-record-dock-'));
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
  const runId = `recorddock${process.pid}${owned.length}`;
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

describe.skipIf(CHROME === null)('the Record button on a phone', () => {
  it(
    'is fully on screen at 430 with nothing scrolled, and so is its options chevron',
    () => {
      const m = measure('phone');
      expect(m.width).toBe(430);

      // The bar no longer runs out of room at this width: six controls came
      // out of the toolbar, so the scroll container it was built to be has
      // nothing left to scroll. The live over-full scenario moved to the
      // control at the bottom of this case, which rebuilds it.
      expect(m.docked.toolbarScrolls).toBe(false);

      // Nothing is scrolled — this is the bar as it is first painted.
      expect(m.docked.toolbarScrollLeft).toBe(0);

      // The two controls, whole, inside the window.
      expect(m.docked.record.left).toBeGreaterThanOrEqual(0);
      expect(m.docked.record.right).toBeLessThanOrEqual(m.width);
      expect(m.docked.options.left).toBeGreaterThanOrEqual(0);
      expect(m.docked.options.right).toBeLessThanOrEqual(m.width);

      // Both are still real tap targets, not slivers: design-mobile.md's
      // floor is 36 on both axes, and the pair had been shaved to 34 and 28
      // wide to buy the toolbar room it no longer has to buy.
      expect(m.docked.record.width).toBeGreaterThanOrEqual(36);
      expect(m.docked.record.height).toBeGreaterThanOrEqual(36);
      expect(m.docked.options.width).toBeGreaterThanOrEqual(36);
      expect(m.docked.options.height).toBeGreaterThanOrEqual(36);

      // They read as one control: side by side on one line, in a dock one row
      // tall. Left to a block box the two buttons wrap onto two lines and the
      // pair stands 72px tall in a 48px bar — measured, which is why the row
      // is asserted and not just the widths.
      expect(m.docked.record.top).toBe(m.docked.options.top);
      expect(m.docked.options.left).toBeGreaterThanOrEqual(m.docked.record.right);
      expect(m.docked.dock.height).toBe(m.docked.record.height);

      // The crumb kept its floor — the toolbar is what yielded, not the
      // doc's own name.
      expect(m.docked.crumb.width).toBeGreaterThanOrEqual(112);

      // The page itself does not scroll sideways.
      expect(m.docked.pageScrollWidth).toBe(m.width);

      // `hidden` actually hides it. The strip sets that attribute the moment a
      // meeting starts, and while the chevron went on being drawn it was a
      // live door to the START chooser sitting beside a running recording.
      // The control is the line above it: visible, the same element is drawn.
      expect(m.chevronShown).not.toBe('none');
      expect(m.chevronHidden).toBe('none');

      // THE CONTROL: refill the toolbar to the width it had before this
      // branch and put the pair back at the end of it, which is where it
      // lived. The bar is over-full again, and the chevron leaves the window.
      expect(m.inToolbar.toolbarScrolls).toBe(true);
      expect(m.inToolbar.options.right).toBeGreaterThan(m.width);
    },
    BROWSER_CASE_MS,
  );

  it(
    'is on screen at 1180x820 too, where the bar has room to spare',
    () => {
      const m = measure('ipad');
      expect(m.width).toBe(1180);
      // Room to spare, so nothing scrolls and the dock changes nothing here.
      expect(m.docked.toolbarScrolls).toBe(false);
      expect(m.docked.record.right).toBeLessThanOrEqual(m.width);
      expect(m.docked.options.right).toBeLessThanOrEqual(m.width);
      expect(m.docked.record.width).toBeGreaterThanOrEqual(36);
      expect(m.docked.pageScrollWidth).toBe(m.width);
      // The label is words at this width, so the pill is wider than a glyph.
      expect(m.docked.record.width).toBeGreaterThan(80);
    },
    BROWSER_CASE_MS,
  );
});
