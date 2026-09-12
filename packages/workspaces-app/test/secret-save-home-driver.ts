#!/usr/bin/env bun
/**
 * Load Home with a secret ask open, at four phone viewports, in one browser.
 *
 * One launch rather than four, for the reason `comment-layout-driver.ts`
 * gives: a browser launch is a process spawn, a profile directory and a CDP
 * handshake before any page exists, and paying that four times to change one
 * number is most of the case's runtime. `Emulation.setDeviceMetricsOverride`
 * moves the viewport between loads, and each viewport gets a fresh page load
 * so the card's first-draw clearance scroll runs at the size being measured.
 *
 * FOUR HEIGHTS, NOT FOUR WIDTHS. The fault this exists to catch is a form
 * whose foot lands under a `position: fixed` dock, so the scarce axis is
 * height: 844 is the phone this repo verifies at, 700 and 560 are the same
 * phone with the software keyboard up, and 390x844 is the narrower handset.
 *
 * `secret-save-home.test.ts` spawns this and reads the JSON array it prints.
 * Its own process because a vitest worker blocked on a browser launch stops
 * answering the runner's RPC, and because the profile cleanup has to run even
 * when a case throws.
 *
 * The two stylesheet reads below put the sheets in the PAGE. Nothing here
 * asserts on their text, and nothing this module exports is one: every export
 * is a type. The marker that claims that exemption is the line comment under
 * this block — inside a block comment it is prose, and the audit is right not
 * to believe prose.
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
import type { Reading } from './secret-save-home-page.ts';

export type { Look, Reading } from './secret-save-home-page.ts';

const SRC = join(import.meta.dirname, '../src');
const PAGE = join(import.meta.dirname, 'secret-save-home-page.ts');

/** The heights a phone actually presents, keyboard down and up. */
const VIEWPORTS: ReadonlyArray<{ width: number; height: number }> = [
  { width: 390, height: 844 },
  { width: 430, height: 844 },
  { width: 430, height: 700 },
  { width: 430, height: 560 },
];

function buildPage(dir: string): string {
  const bundle = join(dir, 'home.js');
  const built = spawnSync(
    'bun',
    ['build', PAGE, '--target', 'browser', '--format', 'esm', '--outfile', bundle],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (built.status !== 0) throw new Error(`bundling the page failed:\n${built.stderr}`);
  // The board's own sheet order — `renderBoardShell` links board.css, then
  // styles.css. Reversing it reverses about thirty equal-specificity ties.
  const html = join(dir, 'home.html');
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
  // Poll for the module, rather than sleeping on it: a bundle that failed to
  // evaluate would otherwise read as a slow one.
  for (let i = 0; i < 80; i++) {
    if (await cdp.evaluate('typeof window.cwSecretHomeRead === "function"')) break;
    await sleep(50);
  }
  const json = (await cdp.evaluate(
    `window.cwSecretHomeRead(${size.width}, ${size.height})`,
  )) as string;
  return JSON.parse(json) as Reading;
}

const runId = `secrethome${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-secret-save-home-'));
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
