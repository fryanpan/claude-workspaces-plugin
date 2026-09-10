/**
 * The live transcript never paints two runs of text on top of each other.
 *
 * In the 2026-09-10 meeting the pane painted a smear — one run of speech drawn
 * over another, unreadable at a glance — and a later moment in the same meeting
 * was clean. The trigger is a tick that composed nothing: the server reports
 * `empty` and drops those turns from its carry, so they stay at the head of the
 * live stream for the rest of the meeting and every later tick composes turns
 * with a survivor in front of them. Lifting those into a chunk — a block ABOVE
 * the stream — made the hold measure a whole line of drop with no tail to
 * indent past, so it pulled the stream up onto the chunk. Measured before the
 * fix: 157.5px of one line over another at 1180x820, 92px at 430, both runs
 * fully opaque.
 *
 * WHY THIS RUNS A REAL BROWSER. happy-dom lays nothing out (`css-harness.ts`
 * says so) and the whole of this bug is used geometry — every declaration
 * involved reads the same before and after. Only measured rects can see it,
 * which is what testing standard 1 asks for and what `bun run ui:shot` gives.
 *
 * The scenario carries its own control: `liveZoneControl` rebuilds the pre-fix
 * offsets by hand over a chunk that is really on screen, so a run in which the
 * sampler measured nothing fails there rather than passing everything here
 * vacuously.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RUN_ID_ENV, profilesOfRun, resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import type { DriveOptions, DriveResult, Overlap } from './meeting-live-overdraw-driver.ts';

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
const DRIVER = join(import.meta.dirname, 'meeting-live-overdraw-driver.ts');

// audit: not-source — the sheets are INSTALLED into a real browser and the
// bundle is EXECUTED by it; nothing below asserts on either one's text, and
// every expectation in this file is a measured pixel area.
const readText = (path: string): string => readFileSync(path, 'utf8');

/**
 * A launch plus a thirty-write meeting is well past vitest's 5s default, so
 * both budgets are named: the case's, and the subprocess's.
 */
const BROWSER_CASE_MS = 180_000;
const SPAWN_MS = 170_000;

/**
 * The smear is a fraction of a line of text over another line. A whole
 * overlapped line measured 1360px² at 1180 and 1567px² at 430 before the fix,
 * and a clean run measures a flat zero — the settle leaves the stream BESIDE
 * the chunk's tail, not on it. 40px² is a couple of characters: far under the
 * bug and far over the sub-pixel adjacency a correct hold leaves behind.
 */
const SMEAR_PX2 = 40;

const dirs: string[] = [];
const owned: string[] = [];

/** The review editor as the meeting mounts it, with the zone's module in it. */
function page(bundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<style>${readText(join(SRC, 'styles.css'))}</style>
<style>${readText(join(SRC, 'doc.css'))}</style>
<style>${readText(join(SRC, 'tokens.css'))}</style>
<style>html,body{margin:0}#editor-pane{position:relative;display:flex;flex-direction:column;height:100vh}</style>
</head><body>
<section id="editor-pane">
  <div id="editor" class="prose redline-layout">
    <div class="ProseMirror" contenteditable="true"><p><br></p></div>
    <div class="markup-margin"></div>
  </div>
</section>
<script type="module">${bundle}</script>
</body></html>`;
}

/** Build the driver — and the real live zone it imports — for the browser. */
function buildPage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-overdraw-'));
  dirs.push(dir);
  const bundle = join(dir, 'driver.js');
  const built = spawnSync(
    'bun',
    ['build', DRIVER, '--target', 'browser', '--format', 'esm', '--outfile', bundle],
    { encoding: 'utf8', timeout: 60_000 },
  );
  expect(built.status, built.stderr).toBe(0);
  const html = join(dir, 'meeting.html');
  writeFileSync(html, page(readText(bundle)));
  return html;
}

/** Run one probe in a headless browser at one of the two verified widths. */
function inBrowser(html: string, preset: 'ipad' | 'phone', probe: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-overdraw-probe-'));
  dirs.push(dir);
  const file = join(dir, 'probe.js');
  writeFileSync(file, probe);
  const runId = `overdraw${process.pid}${owned.length}`;
  owned.push(runId);
  const r = spawnSync(
    'bun',
    [SHOT, '--url', `file://${html}`, '--preset', preset, '--settle', '200', '--eval-file', file],
    { encoding: 'utf8', timeout: SPAWN_MS, env: { ...process.env, [RUN_ID_ENV]: runId } },
  );
  expect(r.status, r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as { result: string }).result;
}

interface Reading {
  control: { worst: Overlap; line: number };
  meeting: DriveResult;
  unhurried: DriveResult;
}

/**
 * Every scenario in ONE page load: a launch, a profile directory and a CDP
 * handshake cost more than the meetings do, and the zones are torn down
 * between runs.
 */
function measure(html: string, preset: 'ipad' | 'phone', runs: readonly DriveOptions[]): Reading {
  const probe = `(async () => JSON.stringify({
    control: JSON.parse(await window.liveZoneControl()),
    meeting: JSON.parse(await window.liveZoneDrive(${JSON.stringify(runs[0])})),
    unhurried: JSON.parse(await window.liveZoneDrive(${JSON.stringify(runs[1])})),
  }))()`;
  return JSON.parse(inBrowser(html, preset, probe)) as Reading;
}

/**
 * A meeting's worth of writes, with every awkward moment in it: ticks that
 * compose nothing, notes landing back to back, and a second split arriving one
 * beat into the last one's fade.
 */
const MEETING: DriveOptions = {
  writes: 45,
  emptyEvery: 5,
  failEvery: 7,
  midSplit: false,
  backToBack: true,
  scale: 0.25,
};

/** The same awkward moments with the settle given room, plus the mid-animation
 *  split — which needs a quiet gap to be a second split rather than a third. */
const UNHURRIED: DriveOptions = {
  writes: 8,
  emptyEvery: 3,
  failEvery: 5,
  midSplit: true,
  backToBack: false,
  scale: 0.25,
};

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

describe.skipIf(CHROME === null)('the live transcript never draws over itself', () => {
  for (const preset of ['ipad', 'phone'] as const) {
    const width = preset === 'ipad' ? '1180x820' : '430';
    it(
      `holds through thirty note-writes and every awkward tick at ${width}`,
      () => {
        const {
          control: c,
          meeting,
          unhurried,
        } = measure(buildPage(), preset, [MEETING, UNHURRIED]);

        // The control first: the pre-fix offsets, painted on purpose. Without
        // it a sampler that measured nothing would pass every case below.
        expect(c.line).toBeGreaterThan(10);
        expect(c.worst.area).toBeGreaterThan(SMEAR_PX2 * 10);
        expect(c.worst.height).toBeGreaterThan(c.line * 0.8);

        // The meeting really ran: thirty writes, sampled every frame, with
        // ticks that composed nothing leaving words stranded in the stream —
        // the state the smear needs.
        // Thirty note-writes that actually WROTE one: the ticks that composed
        // nothing and the ticks that failed are extra, not part of the count.
        expect(meeting.written).toBeGreaterThanOrEqual(30);
        expect(meeting.samples).toBeGreaterThan(50);
        expect(meeting.stranded).toBeGreaterThan(0);
        expect(meeting.worst.area).toBeLessThan(SMEAR_PX2);

        expect(unhurried.samples).toBeGreaterThan(50);
        expect(unhurried.stranded).toBeGreaterThan(0);
        expect(unhurried.worst.area).toBeLessThan(SMEAR_PX2);
      },
      BROWSER_CASE_MS,
    );
  }
});
