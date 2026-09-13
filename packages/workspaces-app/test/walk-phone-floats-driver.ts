#!/usr/bin/env bun
/**
 * Load Home's walkthrough with the widget seated over it, at the two phone
 * widths, in one browser.
 *
 * One launch and a page load per viewport, for the reason
 * `secret-save-home-driver.ts` gives. `walk-phone-floats.test.ts` spawns this
 * and reads the JSON array it prints.
 *
 * The two stylesheet reads below put the sheets in the PAGE. Nothing here
 * asserts on their text, and every export is a type.
 */
// audit: no-text
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import type { Reading } from './walk-phone-floats-page.ts';

export type { HandOver, Reading, Sweep } from './walk-phone-floats-page.ts';

const SRC = join(import.meta.dirname, '../src');
const PAGE = join(import.meta.dirname, 'walk-phone-floats-page.ts');

const VIEWPORTS: ReadonlyArray<{ width: number; height: number }> = [
  { width: 390, height: 844 },
  { width: 430, height: 844 },
];

function buildPage(dir: string): string {
  const bundle = join(dir, 'walk.js');
  const built = spawnSync(
    'bun',
    ['build', PAGE, '--target', 'browser', '--format', 'esm', '--outfile', bundle],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (built.status !== 0) throw new Error(`bundling the page failed:\n${built.stderr}`);
  // The board's own sheet order: board.css, then styles.css.
  const html = join(dir, 'walk.html');
  writeFileSync(
    html,
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<style>${readFileSync(join(SRC, 'board.css'), 'utf8')}</style>
<style>${readFileSync(join(SRC, 'styles.css'), 'utf8')}</style>
<style>html,body{margin:0}</style>
</head><body class="board-body">
<script type="module">${readFileSync(bundle, 'utf8')}</script>
</body></html>`,
  );
  return html;
}

async function drive(
  cdp: Cdp,
  html: string,
  size: { width: number; height: number },
): Promise<Reading> {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: size.width,
    height: size.height,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp.send('Page.navigate', { url: `file://${html}` });
  await cdp.once('Page.loadEventFired');
  for (let i = 0; i < 80; i++) {
    if (await cdp.evaluate('typeof window.cwWalkFloatsRead === "function"')) break;
    await sleep(50);
  }
  const json = (await cdp.evaluate(
    `window.cwWalkFloatsRead(${size.width}, ${size.height})`,
  )) as string;
  return JSON.parse(json) as Reading;
}

const runId = `walkfloats${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-walk-phone-floats-'));
let browser: Browser | undefined;
try {
  const html = buildPage(dir);
  browser = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs(VIEWPORTS[0] as { width: number; height: number }, profile),
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
  for (const size of VIEWPORTS) readings.push(await drive(cdp, html, size));
  cdp.close();
  console.log(JSON.stringify(readings));
} finally {
  const proc: ChildProcess | undefined = browser?.proc;
  try {
    proc?.kill();
  } catch {}
  await sleep(400);
  rmSync(dir, { recursive: true, force: true });
  for (const name of profilesOfRun(readdirSync(tmpdir()), runId)) {
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
    } catch {}
  }
}
process.exit(0);
