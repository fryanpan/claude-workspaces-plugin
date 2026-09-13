#!/usr/bin/env bun
/**
 * Where the Feedback panel and a thread popover land on a page wider than
 * the phone it is open on.
 *
 * Spawned by `widget-panel-edge.test.ts`, which reads the JSON it prints. Its
 * own process for the reason `post-click-driver.ts` gives: one browser launch
 * with a cleanup that must run even when a case throws.
 *
 * The page is the shape of the checkout mock the bug was seen on: a top bar
 * that does not wrap, so at phone width the page runs off the right edge. A
 * mobile browser then lays `position: fixed` out against the whole width of
 * the page rather than the screen, and `window.innerWidth` reports that width
 * too — so anything placed from the right, or clamped to `innerWidth`, stands
 * partly past the screen's edge. Neither happens on a page that fits, which
 * is why the other layout drivers never saw it.
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

const TAG = 'claude-feedback-widget';
const SHADOW = `document.querySelector('${TAG}').shadowRoot`;

/** [left, top, right, bottom], rounded. */
export type Box = [number, number, number, number];

export interface Reading {
  width: number;
  height: number;
  /** The page's own width as the browser reports it: wider than the screen
   *  on a phone is the condition under test. */
  innerWidth: number;
  /** The screen: the visual viewport's left offset and width. */
  vv: [number, number];
  /** The open Feedback panel. */
  panel: Box | null;
  /** A popover opened from the far end of a heading that runs past the
   *  screen, and one from a pin near the screen's right edge. */
  fromRow: Box | null;
  fromPin: Box | null;
}

function pageHtml(bundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{font:15px/1.5 system-ui;margin:0;background:#f7f7f2}
 header{display:flex;gap:24px;padding:14px 32px;background:#fff;white-space:nowrap}
 main{padding:24px}
</style></head>
<body>
<header><b>Riverbend Ferries</b><span>Timetable</span><span>Fares</span><span>Harbours</span><span>Saltmarsh line</span><span>Help</span></header>
<main><h1 id="title">Harborlight open day</h1></main>
<${TAG} doc-id="panel-edge" workspace-id="w-demo" user="Test Reviewer" server-url="ws://127.0.0.1:1"></${TAG}>
<script>${bundle}</script>
</body></html>`;
}

/** The shipped widget, plus the popover's placement on `window` so a thread
 *  can be opened without a server to hold one. */
function buildWidget(dir: string): string {
  const entry = join(dir, 'entry.ts');
  const src = (f: string) => JSON.stringify(join(import.meta.dirname, '../src', f));
  writeFileSync(
    entry,
    `import ${src('widget.ts')};\n` +
      `import { showThreadPopover } from ${src('widget-threads.ts')};\n` +
      '(window as unknown as { __pop: unknown }).__pop = showThreadPopover;\n',
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

/** Open a popover at (x, y) the way a row or a pin does, and measure it. */
const popover = (x: string, y: number) => `(() => {
  const host = document.querySelector('${TAG}');
  window.__pop(host, {
    id: 't1',
    status: 'open',
    anchor: { kind: 'subject' },
    createdBy: { name: 'Test Reviewer', color: '#2e7dd7' },
    comments: [{ id: 'c1', author: { name: 'Test Reviewer', color: '#2e7dd7' }, text: 'The Sunday sailing is missing', ts: 0 }],
  }, ${x}, ${y});
  return (${BOX})(${SHADOW}.querySelector('.thread-popover'));
})()`;

async function drive(cdp: Cdp, dir: string, bundle: string, width: number, height: number) {
  const html = join(dir, `page-${width}.html`);
  writeFileSync(html, pageHtml(bundle));
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 1100,
  });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: `file://${html}` });
  await loaded;
  for (let i = 0; i < 100; i++) {
    if (await cdp.evaluate(`!!${SHADOW}?.querySelector('.fab-list')`)) break;
    await sleep(50);
  }
  // From script: on the page under test the list button itself stands past
  // the screen's edge, and it is the panel's placement being measured.
  await cdp.evaluate(`${SHADOW}.querySelector('.fab-list').click()`);
  const panel = (await cdp.evaluate(`(${BOX})(${SHADOW}.querySelector('.panel'))`)) as Box | null;
  const fromRow = (await cdp.evaluate(
    popover(`document.getElementById('title').getBoundingClientRect().right`, 80),
  )) as Box | null;
  const fromPin = (await cdp.evaluate(
    popover('visualViewport.offsetLeft + visualViewport.width - 24', 120),
  )) as Box | null;
  const [innerWidth, vvLeft, vvWidth] = (await cdp.evaluate(
    '[innerWidth, visualViewport.offsetLeft, visualViewport.width].map(Math.round)',
  )) as [number, number, number];
  return { width, height, innerWidth, vv: [vvLeft, vvWidth], panel, fromRow, fromPin };
}

const runId = `paneledge${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-panel-edge-'));
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
