#!/usr/bin/env bun
/**
 * Where the widget's three other fixed boxes land on a page wider than the
 * phone: the mic's readout, the review-item dock (and the item it opens), and
 * the alert a misconfigured embed shows instead of the launcher.
 *
 * `panel-edge-driver.ts` measures the FAB, the list button, the panel and the
 * popover on the same shape of page, and says why the page is shaped so: a
 * fixed 640px bar, so a phone browser lays `position: fixed` out against the
 * page's width rather than the screen's, and a wheel pan, because a touch
 * scroll gesture did not move the screen on CI's Chrome. These three boxes
 * were left out of that fix, so they get their own look here.
 *
 * Spawned by `widget-edge-boxes.test.ts`, which reads the JSON it prints.
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
const SHADOW = `document.querySelector('${TAG}').shadowRoot`;

/** The screen: the visual viewport's left, top, width and height. */
export type Screen = [number, number, number, number];

/** A board embed with a docked item open and the mic's readout showing. */
export interface Look {
  /** The page's own width as the browser reports it: wider than the screen
   *  on a phone is the condition under test. */
  innerWidth: number;
  vv: Screen;
  readout: Box | null;
  dock: Box | null;
  /** The item the dock opens. */
  modal: Box | null;
}

/** An embed that names no board, showing its alert. */
export interface AlertLook {
  innerWidth: number;
  vv: Screen;
  alert: Box | null;
}

export interface Reading {
  width: number;
  height: number;
  still: Look;
  /** After a pan to the page's right-hand end; phones only. */
  panned: Look | null;
  alertStill: AlertLook;
  alertPanned: AlertLook | null;
}

/** A ticket item linking this page, as the server writes it in. Fictional. */
const LINKED = [
  {
    taskId: 't-ferry',
    reviewItemId: 'r-timetable',
    review: {
      shape: 'decision',
      headline: 'Which Saltmarsh ferry timetable goes on the landing page?',
      options: [
        { id: 'o-summer', label: 'Summer' },
        { id: 'o-winter', label: 'Winter' },
      ],
    },
    by: 'Cartographer',
    ts: 1_700_000_000_000,
  },
];

/** Long enough to reach the readout's widest form. */
const HEARD =
  'Move the Sunday sailing above the fold, and say the last boat back from ' +
  'Riverbend leaves at six so nobody is stranded on the far bank overnight.';

function pageHtml(bundle: string, board: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{font:15px/1.5 system-ui;margin:0;background:#f7f7f2}
 #bar{width:640px;height:48px;background:#fff}
 main{padding:24px}
</style></head>
<body>
<div id="bar"></div>
<main><h1>Harborlight ferry</h1></main>
<script type="application/json" data-cw-linked-items>${JSON.stringify(LINKED)}</script>
<${TAG} doc-id="edge-boxes" ${board ? 'workspace-id="w-demo" ' : ''}user="Test Reviewer" server-url="ws://127.0.0.1:1"></${TAG}>
<script>${bundle}</script>
</body></html>`;
}

/** The shipped widget, plus the mic a host hangs on it. */
function buildWidget(dir: string): string {
  const entry = join(dir, 'entry.ts');
  const src = (f: string) => JSON.stringify(join(import.meta.dirname, '../src', f));
  writeFileSync(
    entry,
    `import ${src('widget.ts')};\n` +
      `import { addMic } from ${src('widget-mic.ts')};\n` +
      '(window as unknown as { __addMic: unknown }).__addMic = addMic;\n',
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

let pages = 0;
async function load(cdp: Cdp, dir: string, html: string, width: number, height: number) {
  pages += 1;
  const file = join(dir, `page-${pages}.html`);
  writeFileSync(file, html);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 1100,
  });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Emulation.setTouchEmulationEnabled', {
    enabled: width <= 1100,
    maxTouchPoints: 5,
  });
  await cdp.send('Page.navigate', { url: `file://${file}` });
  await loaded;
}

async function pan(cdp: Cdp): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: 200,
    y: 300,
    deltaX: 600,
    deltaY: 0,
  });
  for (let i = 0; i < 40; i++) {
    if (((await cdp.evaluate('visualViewport.offsetLeft')) as number) > 0) break;
    await sleep(50);
  }
  // The widget hears the pan through visualViewport's scroll event; give the
  // style a frame to follow it before measuring.
  await cdp.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
}

async function drive(
  cdp: Cdp,
  dir: string,
  bundle: string,
  width: number,
  height: number,
): Promise<Reading> {
  const phone = width <= 1100;
  const screen = async (): Promise<[number, Screen]> => {
    const [w, l, t, vw, vh] = (await cdp.evaluate(
      '[innerWidth, visualViewport.offsetLeft, visualViewport.offsetTop, visualViewport.width, visualViewport.height].map(Math.round)',
    )) as number[];
    return [w as number, [l, t, vw, vh] as Screen];
  };
  const box = async (sel: string) =>
    (await cdp.evaluate(`(${BOX})(${SHADOW}.querySelector('${sel}'))`)) as Box | null;

  // A board embed: the dock, the item it opens, and the mic's readout.
  await load(cdp, dir, pageHtml(bundle, true), width, height);
  await until(cdp, `${SHADOW}?.querySelector('.cw-dock')`);
  await cdp.evaluate(`(() => {
    const host = document.querySelector('${TAG}');
    const { readout } = window.__addMic(host, { comment: 'Comment', voice: 'Speak', history: 'Threads', icon: '' });
    readout.textContent = ${JSON.stringify(HEARD)};
    readout.classList.remove('hidden');
    readout.classList.add('voice-indicator--long');
  })()`);
  await cdp.evaluate(`${SHADOW}.querySelector('.cw-dock-item').click()`);
  await until(cdp, `${SHADOW}.querySelector('.cw-modal')`);
  const look = async (): Promise<Look> => {
    const [innerWidth, vv] = await screen();
    return {
      innerWidth,
      vv,
      readout: await box('.readout'),
      dock: await box('.cw-dock'),
      modal: await box('.cw-modal'),
    };
  };
  const still = await look();
  let panned: Look | null = null;
  if (phone) {
    await pan(cdp);
    panned = await look();
  }

  // An embed that names no board: the alert, alone.
  await load(cdp, dir, pageHtml(bundle, false), width, height);
  await until(cdp, `${SHADOW}?.querySelector('[role=alert]')`);
  const alertLook = async (): Promise<AlertLook> => {
    const [innerWidth, vv] = await screen();
    return { innerWidth, vv, alert: await box('[role=alert]') };
  };
  const alertStill = await alertLook();
  let alertPanned: AlertLook | null = null;
  if (phone) {
    await pan(cdp);
    alertPanned = await alertLook();
  }
  return { width, height, still, panned, alertStill, alertPanned };
}

const runId = `edgeboxes${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-edge-boxes-'));
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
    [390, 844],
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
