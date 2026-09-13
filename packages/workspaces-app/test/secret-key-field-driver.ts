#!/usr/bin/env bun
/**
 * Load both surfaces of a secret ask at four viewports, in one browser, and
 * print what `secret-key-field-page.ts` measured.
 *
 * One launch, eight page loads, for the reason `secret-save-home-driver.ts`
 * gives. `secret-key-field.test.ts` spawns this and reads the JSON array.
 *
 * FOCUS IS EMULATED. A headless page does not hold focus, and an unfocused
 * page fires no `blur` when a field is blurred — measured: the handler never
 * ran, and the box stayed scrolled to its caret. Every reader of this form is
 * in a focused tab, so the page is measured as one.
 *
 * The two stylesheet reads below put the sheets in the PAGE. Nothing here
 * asserts on their text, and every export is a type. The marker that claims
 * that exemption is the line comment under this block.
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
import type { Reading, Surface } from './secret-key-field-page.ts';

export type { Marks, Reading, Surface } from './secret-key-field-page.ts';

const SRC = join(import.meta.dirname, '../src');
const PAGE = join(import.meta.dirname, 'secret-key-field-page.ts');

/** The iPad, the phone this repo verifies at, the same phone with the
 *  keyboard up, and the narrower handset. */
const VIEWPORTS: ReadonlyArray<{ width: number; height: number }> = [
  { width: 1180, height: 820 },
  { width: 430, height: 844 },
  { width: 430, height: 560 },
  { width: 390, height: 844 },
];
const SURFACES: readonly Surface[] = ['home', 'panel'];

function buildPages(dir: string): Record<Surface, string> {
  const bundle = join(dir, 'key-field.js');
  const built = spawnSync(
    'bun',
    ['build', PAGE, '--target', 'browser', '--format', 'esm', '--outfile', bundle],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (built.status !== 0) throw new Error(`bundling the page failed:\n${built.stderr}`);
  // The board's own sheet order, and each surface's own page frame: the panel
  // fixture fills the viewport, Home scrolls it.
  const html = (surface: Surface, frame: string): string => {
    const path = join(dir, `${surface}.html`);
    writeFileSync(
      path,
      `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<style>${readFileSync(join(SRC, 'board.css'), 'utf8')}</style>
<style>${readFileSync(join(SRC, 'styles.css'), 'utf8')}</style>
<style>${frame}</style>
</head><body class="board-body">
<script type="module">${readFileSync(bundle, 'utf8')}</script>
</body></html>`,
    );
    return path;
  };
  return {
    home: html('home', 'html,body{margin:0}'),
    panel: html('panel', 'html,body{margin:0;height:100%}'),
  };
}

async function drive(
  cdp: Cdp,
  html: string,
  surface: Surface,
  size: { width: number; height: number },
): Promise<Reading> {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: size.width,
    height: size.height,
    deviceScaleFactor: 1,
    mobile: size.width <= 1100,
  });
  await cdp.send('Page.navigate', { url: `file://${html}` });
  await cdp.once('Page.loadEventFired');
  for (let i = 0; i < 80; i++) {
    if (await cdp.evaluate('typeof window.cwKeyFieldRead === "function"')) break;
    await sleep(50);
  }
  const json = (await cdp.evaluate(
    `window.cwKeyFieldRead(${JSON.stringify(surface)}, ${size.width}, ${size.height})`,
  )) as string;
  return JSON.parse(json) as Reading;
}

const runId = `keyfield${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-secret-key-field-'));
let browser: Browser | undefined;
try {
  const pages = buildPages(dir);
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
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const readings: Reading[] = [];
  for (const surface of SURFACES) {
    for (const size of VIEWPORTS) readings.push(await drive(cdp, pages[surface], surface, size));
  }
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
