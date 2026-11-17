/**
 * The doc header's presence slot takes no room while nobody else is here.
 *
 * Bryan, on a doc: "there's a weird gap in the icons on the top right". The
 * slot the presence deck draws in (`#doc-people`) was kept at 96px with
 * `visibility: hidden` while it was empty, so a reader alone on a doc saw a
 * 96px hole between Aa and the comments button. Empty, the slot now
 * collapses. When somebody arrives it takes its width back, and only the
 * controls to its LEFT move, once: comments and More hold their place, and
 * so does the deck, which is positioned against the toolbar, not the slot.
 *
 * WHY THIS RUNS A REAL BROWSER. Every question here is a measured gap or
 * position, which happy-dom cannot resolve (`css-harness.ts`).
 *
 * THE CASE CARRIES ITS OWN CONTROL. The probe measures the same bar with the
 * slot kept at its old hidden-but-sized state, and that bar shows the hole.
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
const APP = join(import.meta.dirname, '..');
const SHOT = join(import.meta.dirname, '../../../scripts/ui-shot.ts');

// audit: not-source — the sheets and the shell's own markup are INSTALLED
// into a real browser and never asserted on. Every expectation below is a
// measured rectangle.
const read = (rel: string): string => readFileSync(join(APP, rel), 'utf8');

/** The real top bar, lifted out of the shell rather than retyped. */
function topbar(): string {
  const html = read('index.html');
  const open = html.indexOf('<header id="topbar">');
  const close = html.indexOf('</header>', open);
  if (open < 0 || close < 0) throw new Error('no #topbar in index.html');
  return html.slice(open, close + '</header>'.length);
}

const PROBE = `(() => {
  const slot = document.getElementById('doc-people');
  const aa = document.getElementById('toggle-format');
  const comments = document.getElementById('toggle-threads');
  const rect = (el) => el.getBoundingClientRect();
  const reading = () => ({
    slotWidth: Math.round(rect(slot).width),
    aaLeft: Math.round(rect(aa).left),
    aaRight: Math.round(rect(aa).right),
    commentsLeft: Math.round(rect(comments).left),
    deckRight: slot.firstElementChild ? Math.round(rect(slot.firstElementChild).right) : null,
  });
  // Alone: the shell's own state, the slot marked hidden.
  const alone = reading();
  // Somebody arrives: the island takes the class off and draws the deck in
  // the wrapper the board's strip uses.
  const deck = document.createElement('div');
  deck.className = 'board-presence-f';
  deck.innerHTML = '<button class="board-presence-deck"><span class="board-presence-circle">H</span></button>';
  slot.append(deck);
  slot.classList.remove('hidden');
  const company = reading();
  // THE CONTROL: the slot as it stood before this branch — empty, hidden,
  // and still holding its width.
  deck.remove();
  slot.classList.add('hidden');
  slot.style.setProperty('display', 'flex', 'important');
  slot.style.visibility = 'hidden';
  const before = reading();
  return JSON.stringify({ width: window.innerWidth, alone, company, before });
})()`;

interface Reading {
  slotWidth: number;
  aaLeft: number;
  aaRight: number;
  commentsLeft: number;
  deckRight: number | null;
}
interface Measured {
  width: number;
  alone: Reading;
  company: Reading;
  before: Reading;
}

/** A launch plus a load is 4-6s on this machine; vitest's default is 5s. */
const BROWSER_CASE_MS = 60_000;

const owned: string[] = [];
const dirs: string[] = [];

function measure(preset: 'ipad' | 'phone'): Measured {
  const dir = mkdtempSync(join(tmpdir(), 'cw-doc-slot-'));
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
  const runId = `docslot${process.pid}${owned.length}`;
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

describe.skipIf(CHROME === null)('the doc header’s presence slot', () => {
  it(
    'leaves no hole between Aa and comments while the reader is alone, at 1180x820',
    () => {
      const m = measure('ipad');
      expect(m.width).toBe(1180);
      expect(m.alone.slotWidth).toBe(0);
      // Aa sits beside comments: one toolbar gap, not a 96px hole.
      expect(m.alone.commentsLeft - m.alone.aaRight).toBeLessThanOrEqual(12);

      // Somebody arrives: the slot takes its width, comments stays put, and
      // only Aa (left of the slot) moves, once.
      expect(m.company.slotWidth).toBeGreaterThan(0);
      expect(m.company.slotWidth).toBe(m.before.slotWidth);
      expect(m.company.commentsLeft).toBe(m.alone.commentsLeft);
      expect(m.company.aaLeft).toBeLessThan(m.alone.aaLeft);

      // THE CONTROL: the old hidden-but-sized slot leaves the hole.
      expect(m.before.commentsLeft - m.before.aaRight).toBeGreaterThan(90);
    },
    BROWSER_CASE_MS,
  );

  it(
    'leaves no hole at 430 either, where Aa sits after the slot',
    () => {
      const m = measure('phone');
      expect(m.width).toBe(430);
      expect(m.alone.slotWidth).toBe(0);
      expect(m.company.slotWidth).toBeGreaterThan(0);
      expect(m.company.slotWidth).toBe(m.before.slotWidth);
      // Aa is right of the slot on a phone, so it does not move.
      expect(m.company.aaLeft).toBe(m.alone.aaLeft);
      expect(m.company.commentsLeft).toBe(m.alone.commentsLeft);
      // THE CONTROL: the old slot held its width while empty.
      expect(m.before.slotWidth).toBeGreaterThan(60);
    },
    BROWSER_CASE_MS,
  );
});
