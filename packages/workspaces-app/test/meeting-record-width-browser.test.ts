/**
 * The Record button holds ONE width, whatever it is about to capture.
 *
 * Bryan's one request on the approved mock: "keep the button the same size
 * across every state". It now carries two lines of changing text — Record
 * Audio / Recording over a setting that names the source and the voice count
 * — so without a reserved width the pill would resize on every chooser answer
 * and again the moment a recording started, dragging the chevron and the
 * toolbar beside it. A control that moves under the thumb is the house rule
 * this is measured against.
 *
 * WHY A REAL BROWSER. The width is a layout result: a hidden column holding
 * every face at zero height, and a chevron kept in place with `visibility`
 * rather than `display`. happy-dom lays nothing out (`offsetWidth` is always
 * 0 — see `css-harness.ts`), so this is standard 5's headless Chromium, at the
 * two widths design-mobile.md names.
 *
 * THE CONTROL RUNS IN THE SAME PAGE. With the sizer taken out and the chevron
 * put back on `display: none`, the same readings spread apart — so a probe
 * that measured nothing fails here rather than passing everything vacuously.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { RUN_ID_ENV, profilesOfRun } from '../../../scripts/ui-shot-lib.ts';
import {
  RECORD_LABEL,
  SOURCE_GLYPH,
  VOICES_GLYPH,
  everyRecordLabel,
  everyRecordSetting,
  recordSetting,
} from '../src/meeting-record-face.ts';

/** The browser these cases may launch, or null to skip them. */
const CHROME = chromeForSuite();

const SRC = join(import.meta.dirname, '../src');
const SHOT = join(import.meta.dirname, '../../../scripts/ui-shot.ts');

// audit: not-source — the sheets are INSTALLED into a real browser; every
// expectation below is a measured pixel, never a string found in a file.
const sheet = (name: string): string => readFileSync(join(SRC, name), 'utf8');

const BROWSER_CASE_MS = 120_000;
const SPAWN_MS = 110_000;

const dirs: string[] = [];
const owned: string[] = [];

/** The dock exactly as `mountMeetingStrip` builds it, idle on the microphone. */
function dockMarkup(): string {
  const sizer = [
    ...everyRecordLabel().map((l) => `<span class="meeting-record-label">${l}</span>`),
    ...everyRecordSetting().map((s) => `<span class="meeting-record-setting">${s}</span>`),
  ].join('');
  return `<div class="meeting-record-dock">
  <button type="button" id="record" class="meeting-record" aria-haspopup="menu" aria-expanded="false">
    <span class="meeting-record-glyph" id="glyph">${SOURCE_GLYPH.mic}</span>
    <span class="meeting-record-dot" id="dot" aria-hidden="true" hidden></span>
    <span class="meeting-record-text">
      <span class="meeting-record-label" id="label">${RECORD_LABEL.idle}</span>
      <span class="meeting-record-setting" id="setting">${recordSetting('mic', 'conversation')}</span>
      <span class="meeting-record-sizer" aria-hidden="true">${sizer}</span>
    </span>
    <span class="meeting-record-marks" id="marks" aria-hidden="true">${VOICES_GLYPH.conversation}</span>
  </button>
  <button type="button" id="options" class="meeting-record-options" aria-label="Recording options"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none"/></svg></button>
</div>`;
}

function page(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${sheet('styles.css')}</style>
<style>${sheet('doc.css')}</style>
<style>${sheet('tokens.css')}</style>
<style>html,body{margin:0}</style>
</head><body><div id="shell"><header id="topbar">
<div class="doc-crumb"><span class="doc-label">Reading:</span><span class="doc-path">Thursday planning — notes.md</span></div>
<div class="toolbar"><button type="button" class="icon-btn">Aa</button></div>
${dockMarkup()}
</header></div></body></html>`;
}

/** One state of the control, measured. */
interface Reading {
  /** The pill's own width. */
  record: number;
  /** The pill plus its chevron — what the bar has to make room for. */
  dock: number;
  /** Where the chevron's right edge lands; the toolbar sits left of it. */
  dockRight: number;
  /** Whether the words are on screen at this width. */
  labelWidth: number;
  settingWidth: number;
  /** The narrow-width marks, which carry the voice count when words are gone. */
  marksWidth: number;
  /** The chevron's reserved box; 0 means the dock shrank when it hid. */
  optionsWidth: number;
}

const PROBE = `(() => {
  const label = document.getElementById('label');
  const setting = document.getElementById('setting');
  const marks = document.getElementById('marks');
  const dot = document.getElementById('dot');
  const options = document.getElementById('options');
  const record = document.getElementById('record');
  const dock = document.querySelector('.meeting-record-dock');
  const w = (el) => +el.getBoundingClientRect().width.toFixed(2);
  const read = () => ({
    record: w(record),
    dock: w(dock),
    dockRight: +dock.getBoundingClientRect().right.toFixed(2),
    labelWidth: w(label),
    settingWidth: w(setting),
    marksWidth: w(marks),
    optionsWidth: w(options),
  });
  /** Wear one face and measure. */
  const wear = (head, line, live) => {
    label.textContent = head;
    setting.textContent = line;
    dot.hidden = !live;
    options.hidden = live;
    record.classList.toggle('is-live', live);
    return read();
  };
  const faces = __FACES__;
  const fixed = faces.map((f) => wear(f[0], f[1], f[2]));
  // The control: the reserved width taken away and the chevron put back on
  // display:none, which is the pre-fix behaviour of both.
  const sizer = document.querySelector('.meeting-record-sizer');
  sizer.style.display = 'none';
  const style = document.createElement('style');
  style.textContent = '.meeting-record-options[hidden]{display:none !important}';
  document.head.append(style);
  const control = faces.map((f) => wear(f[0], f[1], f[2]));
  return JSON.stringify({ fixed, control });
})()`;

/** Every face the button can wear: each setting idle, and one recording. */
function faces(): Array<[string, string, boolean]> {
  const out: Array<[string, string, boolean]> = everyRecordSetting().map(
    (s): [string, string, boolean] => [RECORD_LABEL.idle, s, false],
  );
  for (const s of everyRecordSetting()) out.push([RECORD_LABEL.live, s, true]);
  return out;
}

function measure(size: string): { fixed: Reading[]; control: Reading[] } {
  const dir = mkdtempSync(join(tmpdir(), 'cw-record-width-'));
  dirs.push(dir);
  const html = join(dir, 'record.html');
  writeFileSync(html, page());
  const file = join(dir, 'probe.js');
  writeFileSync(file, PROBE.replace('__FACES__', JSON.stringify(faces())));
  const runId = `recordwidth${process.pid}${owned.length}`;
  owned.push(runId);
  const r = spawnSync(
    'bun',
    [SHOT, '--url', `file://${html}`, '--size', size, '--settle', '200', '--eval-file', file],
    { encoding: 'utf8', timeout: SPAWN_MS, env: { ...process.env, [RUN_ID_ENV]: runId } },
  );
  expect(r.status, r.stderr).toBe(0);
  const out = (JSON.parse(r.stdout) as { result: string }).result;
  return JSON.parse(out) as { fixed: Reading[]; control: Reading[] };
}

const spread = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  const tmp = tmpdir();
  for (const runId of owned) {
    for (const name of profilesOfRun(readdirSync(tmp), runId)) {
      rmSync(join(tmp, name), { recursive: true, force: true });
    }
  }
});

describe.skipIf(!CHROME)('the Record button keeps one width', () => {
  it(
    'at 1180x820 every face measures the same — and spreads apart without the reserved width',
    () => {
      const { fixed, control } = measure('1180x820');
      expect(fixed).toHaveLength(faces().length);
      // Done-when: the pill, and the dock the bar sizes around it, never move.
      expect(spread(fixed.map((r) => r.record))).toBe(0);
      expect(spread(fixed.map((r) => r.dock))).toBe(0);
      expect(spread(fixed.map((r) => r.dockRight))).toBe(0);
      // The chevron keeps its box while recording rather than collapsing it.
      for (const r of fixed) expect(r.optionsWidth).toBeGreaterThan(0);
      // The words are what is being held to one width at this size.
      for (const r of fixed) expect(r.settingWidth).toBeGreaterThan(0);

      // The control is the bug: the same faces without the sizer and with the
      // chevron back on display:none resize the pill and move the dock.
      expect(spread(control.map((r) => r.record))).toBeGreaterThan(4);
      expect(spread(control.map((r) => r.dock))).toBeGreaterThan(4);
      expect(control.some((r) => r.optionsWidth === 0)).toBe(true);
    },
    BROWSER_CASE_MS,
  );

  it(
    'at 430 the words are gone and the two marks carry both facts, still at one width',
    () => {
      const { fixed } = measure('430x932');
      expect(spread(fixed.map((r) => r.record))).toBe(0);
      expect(spread(fixed.map((r) => r.dock))).toBe(0);
      for (const r of fixed) {
        // Bryan's phone ruling: no words in the bar at this width.
        expect(r.labelWidth).toBe(0);
        expect(r.settingWidth).toBe(0);
        // What is left says how many voices; the glyph beside it says the
        // source. Both would be nothing at all before this change.
        expect(r.marksWidth).toBeGreaterThan(0);
        // design-mobile.md's tap-target floor still applies to the pill.
        expect(r.record).toBeGreaterThanOrEqual(36);
      }
      // And the dock still fits the viewport, which is what put it outside
      // the scrolling toolbar in the first place.
      for (const r of fixed) expect(r.dockRight).toBeLessThanOrEqual(430);
    },
    BROWSER_CASE_MS,
  );
});
