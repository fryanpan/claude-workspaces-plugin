/**
 * The floating buttons cover nothing on the Library page: not the last row's
 * time, and not the rail's Settings and Collapse.
 *
 * Two defects, both seen at 1180x820 on the Library's All files view.
 *
 * - THE TAIL. Three widget buttons stack in the viewport's bottom-right
 *   corner. The list reserved exactly the stack's height, so at the end of
 *   the scroll the last row's box ended ON the topmost button's top edge
 *   (650.3 against 650), with that button's count badge reaching 4px into
 *   the row. The list now keeps 12px of daylight above the stack.
 * - THE RAIL FOOT. The mic dock is `position: sticky` so it stays in view on
 *   a tall page; Settings and Collapse above it were not. Scrolling down, the
 *   two rose from the viewport's foot INTO the stuck dock: between 220 and
 *   320px of a 380px scroll the centre of each hit-tested to
 *   `.board-nav-dock`. They now stick above it.
 *
 * WHY A REAL BROWSER. Both are used geometry — where a sticky box parks, what
 * a fixed button sits over at a scroll position — and happy-dom lays nothing
 * out. The cascade half of the tail is `library-tail-css.test.ts`.
 *
 * THE BUTTONS ARE THE WIDGET'S OWN. The page seats `.fab`, `.fab-list.side`
 * (with its badge showing) and `.fab-list.fab-mic` in a shadow root under the
 * widget's real sheets, `widgetStyles` and `MIC_CSS`, so a button that moves
 * moves here too.
 *
 * THE CONTROLS RUN IN THE SAME PAGE. Each probe rebuilds the pre-fix rule
 * inline and measures again, so a probe that measured nothing fails on its
 * control instead of passing on its reading.
 *
 * All fixtures synthetic.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RUN_ID_ENV, profilesOfRun, resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import { widgetStyles } from '../../widget/src/styles.ts';
import { MIC_CSS } from '../../widget/src/widget-mic.ts';

/** Is there a browser to launch — asked the way `ui-shot.ts` asks. */
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

const NAV_ITEM = (label: string, cls = ''): string =>
  `<button type="button" class="board-nav-item ${cls}"><span class="board-nav-icon"></span><span class="board-nav-label">${label}</span></button>`;

/** The board shell around the Library's All files view, 24 rows long. */
function page(): string {
  const rows = Array.from(
    { length: 24 },
    (_, i) =>
      `<a class="library-row" href="#r${i}"><span class="library-main"><span class="library-name">Riverbend survey note ${i + 1}</span></span><span class="library-when">${i + 1}d ago</span></a>`,
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<style>${readText(join(SRC, 'board.css'))}</style>
<style>${readText(join(SRC, 'styles.css'))}</style>
<style>${readText(join(SRC, 'tokens.css'))}</style>
</head><body class="board-body">
<div id="board-root">
  <header class="board-topbar"><span class="board-ws-name">Harborlight</span></header>
  <div id="board-main" class="board-main">
    <nav id="board-nav" class="board-nav">
      ${NAV_ITEM('Home')}${NAV_ITEM('Tasks')}${NAV_ITEM('Library', 'board-nav-item-active')}${NAV_ITEM('Activity')}
      ${NAV_ITEM('Settings', 'board-nav-settings')}
      ${NAV_ITEM('Collapse', 'board-nav-collapse')}
      <div class="board-nav-dock" role="group" aria-label="Voice">
        <button type="button" class="voice-mic" aria-label="Hold to talk">M</button>
      </div>
    </nav>
    <section class="board-col"><div class="board-library"><div class="library-page">
      <header class="library-top"><div class="library-top-row"><h1 class="library-proj">Harborlight</h1></div>
        <input class="library-search" placeholder="Search"></header>
      <div class="library-body"><div class="library-all"><h2>All files</h2>
        <div class="library-tbl"><div class="library-cols"><span>Name</span><span>File modified</span></div>${rows}</div>
      </div></div>
    </div></div></section>
  </div>
</div>
<claude-feedback-widget></claude-feedback-widget>
<script>
  const root = document.querySelector('claude-feedback-widget').attachShadow({ mode: 'open' });
  root.innerHTML = ${JSON.stringify(
    `<style>${widgetStyles}${MIC_CSS}</style>` +
      '<button class="fab-list side">L<span class="count">3</span></button>' +
      '<button class="fab-list fab-mic">V</button>' +
      '<button class="fab">C</button>',
  )};
</script>
</body></html>`;
}

function buildPage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-board-floats-'));
  dirs.push(dir);
  const html = join(dir, 'library.html');
  writeFileSync(html, page());
  return html;
}

/** The tail at maximum scroll, as fixed and with the pre-fix reservation. */
interface TailReading {
  scrollRemaining: number;
  /** Top of the float stack, badge included, minus the last row's bottom. */
  daylight: number;
  /** Does the last row's time hit-test to itself at its centre? */
  whenHitsSelf: boolean;
}

/** One scroll position where a rail control that is on screen is not on top. */
interface Covered {
  y: number;
  control: string;
  hit: string;
}

interface Reading {
  tail: TailReading;
  tailControl: TailReading;
  /** Rail controls on screen at their centre somewhere in the sweep. */
  seen: string[];
  covered: Covered[];
  coveredControl: Covered[];
  positions: number;
}

const PROBE = `(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const shadow = document.querySelector('claude-feedback-widget').shadowRoot;
  const body = document.querySelector('.library-body');
  const tail = async () => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await frame();
    const rows = document.querySelectorAll('.library-tbl .library-row');
    const last = rows[rows.length - 1];
    let top = Infinity;
    for (const el of shadow.querySelectorAll('button, .count')) {
      if (getComputedStyle(el).display === 'none') continue;
      top = Math.min(top, el.getBoundingClientRect().top);
    }
    const when = last.querySelector('.library-when').getBoundingClientRect();
    const hit = document.elementFromPoint((when.left + when.right) / 2, (when.top + when.bottom) / 2);
    return {
      scrollRemaining: Math.round(document.documentElement.scrollHeight - innerHeight - scrollY),
      daylight: +(top - last.getBoundingClientRect().bottom).toFixed(1),
      whenHitsSelf: !!hit && last.querySelector('.library-when').contains(hit),
    };
  };
  const sweep = async () => {
    const controls = {
      settings: document.querySelector('.board-nav-settings'),
      collapse: document.querySelector('.board-nav-collapse'),
      mic: document.querySelector('.board-nav-dock .voice-mic'),
    };
    const max = document.documentElement.scrollHeight - innerHeight;
    const covered = [];
    const seen = new Set();
    let positions = 0;
    for (let y = 0; y <= max + 9; y += 10) {
      window.scrollTo(0, Math.min(y, max));
      await frame();
      positions++;
      for (const [name, el] of Object.entries(controls)) {
        const b = el.getBoundingClientRect();
        const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
        if (b.width === 0 || cy < 0 || cy >= innerHeight) continue;
        seen.add(name);
        const hit = document.elementFromPoint(cx, cy);
        if (!hit || !el.contains(hit)) covered.push({ y: scrollY, control: name, hit: hit ? hit.className || hit.tagName : 'null' });
      }
    }
    return { covered, seen: [...seen], positions };
  };

  const fixedTail = await tail();
  const fixedSweep = await sweep();

  // The controls: both rules as they were before the fix.
  body.style.paddingBottom = 'calc(146px - var(--board-bottom-bar))';
  const tailControl = await tail();
  body.style.removeProperty('padding-bottom');
  const pin = document.createElement('style');
  pin.textContent = '.board-nav-item.board-nav-settings, .board-nav-item.board-nav-collapse { position: static !important; }';
  document.head.append(pin);
  const controlSweep = await sweep();
  pin.remove();

  return JSON.stringify({
    tail: fixedTail,
    tailControl,
    seen: fixedSweep.seen,
    covered: fixedSweep.covered,
    coveredControl: controlSweep.covered,
    positions: fixedSweep.positions,
  });
})()`;

function measure(html: string, preset: 'ipad' | 'phone'): Reading {
  const dir = mkdtempSync(join(tmpdir(), 'cw-board-floats-probe-'));
  dirs.push(dir);
  const file = join(dir, 'probe.js');
  writeFileSync(file, PROBE);
  const runId = `boardfloats${process.pid}${owned.length}`;
  owned.push(runId);
  const r = spawnSync(
    'bun',
    [SHOT, '--url', `file://${html}`, '--preset', preset, '--settle', '200', '--eval-file', file],
    { encoding: 'utf8', timeout: SPAWN_MS, env: { ...process.env, [RUN_ID_ENV]: runId } },
  );
  expect(r.status, r.stderr).toBe(0);
  const out = (JSON.parse(r.stdout) as { result: string }).result;
  return JSON.parse(out) as Reading;
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

/** One page load per viewport, shared by the cases that read it. */
const readings = new Map<'ipad' | 'phone', Reading>();
function reading(preset: 'ipad' | 'phone'): Reading {
  const had = readings.get(preset);
  if (had) return had;
  const r = measure(buildPage(), preset);
  readings.set(preset, r);
  return r;
}

describe.skipIf(!CHROME)('the Library list clears the floating buttons, in a real browser', () => {
  for (const preset of ['ipad', 'phone'] as const) {
    it(
      `the last row ends above the button stack and its badge (${preset})`,
      () => {
        const r = reading(preset);
        expect(r.tail.scrollRemaining).toBe(0);
        expect(r.tail.daylight).toBeGreaterThanOrEqual(8);
        expect(r.tail.whenHitsSelf).toBe(true);
        // The control is the bug: the old reservation leaves no daylight.
        expect(r.tailControl.scrollRemaining).toBe(0);
        expect(r.tailControl.daylight).toBeLessThanOrEqual(0);
      },
      BROWSER_CASE_MS,
    );
  }
});
describe.skipIf(!CHROME)('the rail foot is never under its own mic, in a real browser', () => {
  it(
    'at 1180x820 Settings, Collapse and the mic are each on top at every scroll position',
    () => {
      const r = reading('ipad');
      // The page really scrolled past the foot, and all three were on screen.
      expect(r.positions).toBeGreaterThan(10);
      expect(r.seen.sort()).toEqual(['collapse', 'mic', 'settings']);
      expect(r.covered).toEqual([]);
      // The control is the bug: unstuck, Settings and Collapse go under the dock.
      expect(r.coveredControl.map((c) => c.control)).toEqual(
        expect.arrayContaining(['settings', 'collapse']),
      );
    },
    BROWSER_CASE_MS,
  );

  it(
    'at 430 the foot is not drawn and the mic in the bottom bar is never covered',
    () => {
      const r = reading('phone');
      expect(r.seen).toEqual(['mic']);
      expect(r.covered).toEqual([]);
    },
    BROWSER_CASE_MS,
  );
});
