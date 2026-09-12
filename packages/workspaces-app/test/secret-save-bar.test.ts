/**
 * Save never covers the field you are pasting into.
 *
 * THE FAULT. The send row under a secret ask was `position: sticky`, painted
 * in the panel's own colour, and a sticky box rises as far as the TOP of its
 * containing block — which here is the form. So a form whose foot sat below
 * the fold had Save painted across its own fields: at 1180x820 the second
 * field's last line hit-tested to the Save row, and at 430 the field was off
 * the bottom of the panel altogether (UX review, 2026-09-12).
 *
 * WHAT REPLACED IT. The row is ordinary again and the scroll reserves its
 * height at the foot of the scrollport, so tapping a field brings Save along
 * with it; and the form scrolls itself clear once when it is first drawn.
 *
 * WHY A REAL BROWSER. Every question here is "what is painted at this point",
 * and happy-dom lays nothing out — `css-harness.ts` says so — so
 * `elementFromPoint` there can only ever answer with the document. Sticky
 * offsets, a textarea grown to three lines by `field-sizing: content` and a
 * scroll-into-view that honours `scroll-padding` are all used-geometry, which
 * is what testing standard 1 asks for and what `bun run ui:shot` gives.
 *
 * THE CONTROLS, because a clean reading proves nothing on its own:
 *  - `formOverflowsPanel` says the fixture still reproduces. A form that fits
 *    on screen has no scroll position with a field against the foot of the
 *    scrollport, and every assertion below would pass with the fix reverted.
 *  - `atRestWithStickyRow` is the same sweep with the sticky rule put back —
 *    the page as the UX walk found it. It must still find Save over a field.
 *  - `saveShownWhenFocusedUnreserved` is the tap with the reserved room taken
 *    off. Save must fail to come along, or the reservation is doing nothing.
 *  - `saveShownOnFirstDraw` is what the draw-time clearance is for, and it
 *    fails when that effect is removed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RUN_ID_ENV, profilesOfRun, resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import type { FieldReading, Probe } from './secret-save-bar-driver.ts';

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
const DRIVER = join(import.meta.dirname, 'secret-save-bar-driver.ts');

// audit: not-source — the sheets are INSTALLED into a real browser and the
// driver is EXECUTED by it; nothing below asserts on either one's text, and
// every expectation in this file is a measured rectangle or the name of the
// element painted at a point.
const readText = (path: string): string => readFileSync(path, 'utf8');

/** A launch and a build is well past vitest's 5s default, so both budgets are
 *  named: the case's, and the subprocess's. */
const BROWSER_CASE_MS = 180_000;
const SPAWN_MS = 170_000;

const dirs: string[] = [];
const owned: string[] = [];

/** The board shell around the detail overlay, in the shell's own sheet order. */
function page(bundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<style>${readText(join(SRC, 'board.css'))}</style>
<style>${readText(join(SRC, 'styles.css'))}</style>
<style>html,body{margin:0;height:100%}</style>
</head><body class="board-body">
<script type="module">${bundle}</script>
</body></html>`;
}

function buildPage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-secret-save-bar-'));
  dirs.push(dir);
  const bundle = join(dir, 'driver.js');
  const built = spawnSync(
    'bun',
    ['build', DRIVER, '--target', 'browser', '--format', 'esm', '--outfile', bundle],
    { encoding: 'utf8', timeout: 120_000 },
  );
  expect(built.status, built.stderr).toBe(0);
  const html = join(dir, 'panel.html');
  writeFileSync(html, page(readText(bundle)));
  return html;
}

/**
 * Drive one width.
 *
 * AWAITED, NOT WAITED FOR — same reason `comments-in-view.test.ts` spawns
 * rather than `spawnSync`s: a worker blocked on a browser launch stops
 * answering vitest's own RPC, and the run dies with a timeout while every
 * case in it passes.
 */
async function measure(html: string, preset: 'ipad' | 'phone'): Promise<Probe> {
  const dir = mkdtempSync(join(tmpdir(), 'cw-secret-save-bar-probe-'));
  dirs.push(dir);
  const file = join(dir, 'probe.js');
  writeFileSync(file, '(async () => await window.secretSaveBarProbe())()');
  const runId = `ssb${process.pid}${owned.length}`;
  owned.push(runId);
  const r = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        'bun',
        [
          SHOT,
          '--url',
          `file://${html}`,
          '--preset',
          preset,
          '--settle',
          '400',
          '--eval-file',
          file,
        ],
        { timeout: SPAWN_MS, env: { ...process.env, [RUN_ID_ENV]: runId } },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => {
        stdout += d;
      });
      child.stderr.setEncoding('utf8').on('data', (d: string) => {
        stderr += d;
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    },
  );
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse((JSON.parse(r.stdout) as { result: string }).result) as Probe;
}

const probes = new Map<'ipad' | 'phone', Promise<Probe>>();
function probeFor(preset: 'ipad' | 'phone'): Promise<Probe> {
  const hit = probes.get(preset);
  if (hit) return hit;
  const got = measure(buildPage(), preset);
  probes.set(preset, got);
  return got;
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

/** The field's own box is what answers at both points. */
function expectReadable(reading: FieldReading, where: string): void {
  expect(reading.lastLine, `${where}: last line of the value`).toContain('board-walk-cred-input');
  expect(reading.eye, `${where}: the eye`).not.toContain('board-walk-cred-send');
  expect(reading.eye, `${where}: the eye`).not.toBe('nothing');
}

/** Nothing about this reading is the Save row. A field scrolled off the
 *  panel reads `nothing`, which is ordinary scrolling and not the fault. */
const savePaintedOver = (r: FieldReading): boolean =>
  r.lastLine.includes('cred-send') || r.eye.includes('cred-send');

describe.skipIf(CHROME === null)('the Save row on a secret ask', () => {
  for (const preset of ['ipad', 'phone'] as const) {
    const width = preset === 'ipad' ? '1180x820' : '430';
    it(
      `is never painted over a field, and arrives with the field when tapped, at ${width}`,
      async () => {
        const p = await probeFor(preset);

        // Controls first: the fixture still overflows, and the row really is
        // an ordinary one now.
        expect(p.formOverflowsPanel).toBe(true);
        expect(p.barPosition).toBe('static');
        expect(Number.parseFloat(p.scrollPadBottom)).toBeGreaterThanOrEqual(92);
        expect(p.firstDraw).toHaveLength(3);
        expect(p.atRest.length).toBeGreaterThan(4);

        // As drawn: the whole form, Save included, and both fields readable.
        p.firstDraw.forEach((r, i) => expectReadable(r, `first draw, field ${i + 1}`));
        expect(p.saveShownOnFirstDraw, 'Save on screen as drawn').toBe(true);

        // Tapped from below the fold: the field is readable and Save came up
        // with it. The LAST field is the one that has to carry Save into view
        // — a reader in the first field still has the second to fill, and
        // pulling the whole form up from there would move the box they are
        // typing in further than the tap asked for.
        p.focused.forEach((r, i) => expectReadable(r, `focused, field ${i + 1}`));
        expect(p.saveShownWhenFocused.at(-1), 'Save arrives with the last field').toBe(true);

        // And at every scroll position the panel has, Save is painted over
        // nothing — which is the property the sticky row could not hold.
        const over = p.atRest.filter(savePaintedOver);
        expect(over, 'Save painted over a field somewhere in the scroll').toEqual([]);

        // The two controls: the old rule still fails, and the room is what
        // brings Save along.
        expect(
          p.atRestWithStickyRow.filter(savePaintedOver).length,
          'the sticky row must still paint over a field',
        ).toBeGreaterThan(0);
        expect(
          p.saveShownWhenFocusedUnreserved.at(-1),
          'without the reserved room Save must be left behind',
        ).toBe(false);
      },
      BROWSER_CASE_MS,
    );
  }
});
