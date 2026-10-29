#!/usr/bin/env bun
/**
 * A served mock with its own buttons fixed in the bottom-right corner, two
 * rounds and a docked review item, in headless Chromium at 1180x820 and
 * 430x932: whether each corner control, the widget's and the mock's own, is
 * on screen and takes a tap at its centre while the dock shows, and where the
 * mock's buttons go once the dock clears.
 *
 * Seen on 28 October from inside a mock of the lead chat: the question bar
 * along the bottom covered the mock's mic and chat buttons, which sat 20px up
 * from the bottom, 132px in from the right.
 *
 * Spawned by `widget-mock-corner-dock.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns was measured in a running browser.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Browser,
  Cdp,
  launchChrome,
  pageSocketUrl,
  sleep,
} from '../../../scripts/headless-chrome.ts';
import { chromeLaunchArgs, profilesOfRun, resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import type { Box } from './panel-edge-driver.ts';

const TAG = 'claude-feedback-widget';
const HOST = `document.querySelector('${TAG}')`;
const SHADOW = `${HOST}.shadowRoot`;

/** A control the reader taps: where it is, and whether a tap reaches it. */
export interface Control {
  name: string;
  box: Box | null;
  /** The page's hit test at the box's centre lands in the control. */
  tapped: boolean;
}

export interface Reading {
  width: number;
  height: number;
  dock: Box | null;
  docked: Control[];
  /** A full-height fixed rail of the mock's, which reaches the dock's band too. */
  rail: Box | null;
  /** The mock's own buttons, before any item docked and after it left. */
  before: Box[];
  cleared: { dock: Box | null; mine: Box[] };
}

/** A ticket item linking this mock, as the server writes it in. Fictional. */
const LINKED = [
  {
    taskId: 't-corner',
    reviewItemId: 'r-corner',
    review: {
      shape: 'question',
      headline: 'Does the Riverbend lead chat open where you expect it to?',
    },
    by: 'Riverbend',
    ts: 1_700_000_000_000,
  },
];

/** The widget's controls, by the selector inside its shadow root. */
const WIDGET_CONTROLS = [
  ['comment bubble', '.fab:not(.fab-list)'],
  ['thread list', '.fab-list.side'],
  ['mic', '.fab-mic'],
  ['pencil', '.fab-edit'],
] as const;
/** The page's own controls, by their selector in the document. */
const PAGE_CONTROLS = [
  ['mock mic', '#mock-mic'],
  ['mock chat', '#mock-chat'],
  ['round chevrons', '[data-cw-mock-versions] button'],
] as const;

function pageHtml(bundle: string, docked: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font:15px/1.5 system-ui;margin:0;background:#f7f7f2} main{padding:24px}
.corner{position:fixed;right:132px;bottom:20px;z-index:900;display:flex;gap:8px}
.rail{position:fixed;left:0;top:0;bottom:0;width:6px;background:#ddd}
.corner button{width:44px;height:44px;border-radius:50%;border:1px solid #ccc;background:#fff}
</style>
</head><body>
<main><h1>Harborlight moorings</h1></main>
<div class="rail" id="mock-rail"></div>
<div class="corner"><button id="mock-mic" aria-label="Talk">M</button><button id="mock-chat" aria-label="Chat">C</button></div>
${docked ? `<script type="application/json" data-cw-linked-items>${JSON.stringify(LINKED)}</script>` : ''}
<${TAG} doc-id="mock-corner-dock" workspace-id="w-demo" user="Saltmarsh" server-url="ws://127.0.0.1:1"></${TAG}>
<script>${bundle}</script>
</body></html>`;
}

/** The shipped widget, plus what a served mock adds to it. */
function buildWidget(dir: string): string {
  const entry = join(dir, 'entry.ts');
  const src = (f: string) => JSON.stringify(join(import.meta.dirname, '../src', f));
  writeFileSync(
    entry,
    `import ${src('widget.ts')};\n` +
      `import * as live from ${src('mockup-live.ts')};\n` +
      `import { keepPageLifted } from ${src('mock-page-lift.ts')};\n` +
      `import { mountVoiceLoader } from ${src('voice/voice-loader.ts')};\n` +
      `import { mountEditLoader } from ${src('edit/edit-button.ts')};\n` +
      '(window as unknown as { __live: unknown }).__live = { ...live, keepPageLifted, mountVoiceLoader, mountEditLoader };\n',
  );
  const built = spawnSync('bun', ['build', entry, '--target=browser'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (built.status !== 0) throw new Error(`bun build failed: ${built.stderr}`);
  return built.stdout;
}

const BOX = `(e) => {
  if (!e || getComputedStyle(e).display === 'none') return null;
  const r = e.getBoundingClientRect();
  return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
}`;

async function until(cdp: Cdp, expr: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await cdp.evaluate(`!!(${expr})`)) return;
    await sleep(50);
  }
  throw new Error(`never became true: ${expr}`);
}

const frames = (cdp: Cdp) =>
  cdp.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');

/** Load the mock, seat what a served mock seats, and wait for the widget. */
async function load(cdp: Cdp, file: string, docked: boolean): Promise<void> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: `file://${file}` });
  await loaded;
  await until(
    cdp,
    `${SHADOW}?.querySelector('.fab')${docked ? ` && ${SHADOW}.querySelector('.cw-dock')` : ''}`,
  );
  await cdp.evaluate(`(() => {
    __live.renderControl({ docId: 'mock-corner-dock', workspaceId: 'w-demo', version: null, versions: [1, 2] }, () => {});
    __live.keepControlLifted();
    __live.keepPageLifted(document);
    __live.mountVoiceLoader(document, 'voice.js');
    __live.mountEditLoader(document, 'edit.js');
  })()`);
  await frames(cdp);
}

const mineBoxes = async (cdp: Cdp): Promise<Box[]> =>
  (await cdp.evaluate(
    `['#mock-mic', '#mock-chat'].map((s) => (${BOX})(document.querySelector(s)))`,
  )) as Box[];

async function drive(cdp: Cdp, dir: string, bundle: string, width: number, height: number) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 1100,
  });
  const plain = join(dir, `plain-${width}.html`);
  writeFileSync(plain, pageHtml(bundle, false));
  await load(cdp, plain, false);
  const before = await mineBoxes(cdp);

  const file = join(dir, `page-${width}.html`);
  writeFileSync(file, pageHtml(bundle, true));
  await load(cdp, file, true);
  const box = async (expr: string) => (await cdp.evaluate(`(${BOX})(${expr})`)) as Box | null;
  const hit = async (root: string, sel: string, b: Box | null): Promise<boolean> =>
    b !== null &&
    ((await cdp.evaluate(
      `!!${root}.elementFromPoint(${(b[0] + b[2]) / 2}, ${(b[1] + b[3]) / 2})?.closest(${JSON.stringify(sel)})`,
    )) as boolean);
  const docked: Control[] = [];
  for (const [name, sel] of WIDGET_CONTROLS) {
    const b = await box(`${SHADOW}.querySelector(${JSON.stringify(sel)})`);
    docked.push({ name, box: b, tapped: await hit(SHADOW, sel, b) });
  }
  for (const [name, sel] of PAGE_CONTROLS) {
    const b = await box(`document.querySelector(${JSON.stringify(sel)})`);
    docked.push({ name, box: b, tapped: await hit('document', sel, b) });
  }
  const dock = await box(`${SHADOW}.querySelector('.cw-dock')`);
  const rail = await box(`document.querySelector('#mock-rail')`);

  // The item is answered elsewhere and leaves the dock.
  await cdp.evaluate(`(() => { ${HOST}.linkedItems = []; ${HOST}.scheduleRender(); })()`);
  await until(cdp, `!${SHADOW}.querySelector('.cw-dock')`);
  const lifted = JSON.stringify(await mineBoxes(cdp));
  // Bounded: on a build that never lifted the mock's buttons they never move.
  for (let i = 0; i < 20; i++) {
    if (JSON.stringify(await mineBoxes(cdp)) !== lifted) break;
    await sleep(50);
  }
  await frames(cdp);
  const cleared = {
    dock: await box(`${SHADOW}.querySelector('.cw-dock')`),
    mine: await mineBoxes(cdp),
  };
  return { width, height, dock, docked, rail, before, cleared };
}

const runId = `mockcornerdock${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-mock-corner-dock-'));
let browser: Browser | undefined;
const stop = (proc: ChildProcess | undefined): void => {
  try {
    proc?.kill();
  } catch {}
};
try {
  const bundle = buildWidget(dir);
  browser = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
    60_000,
    runId,
    (b) => {
      browser = b;
    },
  );
  const cdp = await Cdp.connect(await pageSocketUrl(browser.port, 30_000));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const readings: Reading[] = [];
  for (const [w, h] of [
    [1180, 820],
    [430, 932],
  ] as const) {
    readings.push(await drive(cdp, dir, bundle, w, h));
  }
  cdp.close();
  console.log(JSON.stringify(readings));
} finally {
  stop(browser?.proc);
  await sleep(400);
  rmSync(dir, { recursive: true, force: true });
  for (const name of profilesOfRun(readdirSync(tmpdir()), runId)) {
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
    } catch {}
  }
}
process.exit(0);
