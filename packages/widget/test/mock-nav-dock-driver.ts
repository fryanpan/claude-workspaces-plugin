#!/usr/bin/env bun
/**
 * A served mock with two rounds and a docked review item, in headless
 * Chromium at 1180x820 and 430x932: where the round chevrons, the dock, the
 * FAB and the list button land, and where the chevrons go once the dock
 * clears.
 *
 * Seen on an iPad: the dock was drawn over the chevrons, which cannot then be
 * seen or tapped.
 *
 * Spawned by `widget-mock-nav-dock.test.ts`, which reads the JSON it prints.
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

export interface Reading {
  width: number;
  height: number;
  docked: {
    dock: Box | null;
    chevrons: Box | null;
    fab: Box | null;
    list: Box | null;
    /** The page's own hit test at the back chevron's centre lands in it. */
    chevronOnTop: boolean;
  };
  /** After the item leaves the dock. */
  cleared: { dock: Box | null; chevrons: Box | null };
}

/** A ticket item linking this mock, as the server writes it in. Fictional. */
const LINKED = [
  {
    taskId: 't-pins',
    reviewItemId: 'r-pins',
    review: {
      shape: 'decision',
      headline: 'Do these pins show where the Riverbend mock comments are?',
      options: [
        { id: 'o-yes', label: 'Yes' },
        { id: 'o-no', label: 'No' },
      ],
    },
    by: 'Cartographer',
    ts: 1_700_000_000_000,
  },
];

function pageHtml(bundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:15px/1.5 system-ui;margin:0;background:#f7f7f2} main{padding:24px}</style>
</head><body>
<main><h1>Harborlight moorings</h1></main>
<script type="application/json" data-cw-linked-items>${JSON.stringify(LINKED)}</script>
<${TAG} doc-id="mock-nav-dock" workspace-id="w-demo" user="Reviewer" server-url="ws://127.0.0.1:1"></${TAG}>
<script>${bundle}</script>
</body></html>`;
}

/** The shipped widget, plus the mockup chevrons a served mock adds. */
function buildWidget(dir: string): string {
  const entry = join(dir, 'entry.ts');
  const src = (f: string) => JSON.stringify(join(import.meta.dirname, '../src', f));
  writeFileSync(
    entry,
    `import ${src('widget.ts')};\n` +
      `import * as live from ${src('mockup-live.ts')};\n` +
      '(window as unknown as { __live: unknown }).__live = live;\n',
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

async function drive(
  cdp: Cdp,
  dir: string,
  bundle: string,
  width: number,
  height: number,
): Promise<Reading> {
  const file = join(dir, `page-${width}.html`);
  writeFileSync(file, pageHtml(bundle));
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 1100,
  });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: `file://${file}` });
  await loaded;
  await until(cdp, `${SHADOW}?.querySelector('.cw-dock') && ${SHADOW}.querySelector('.fab')`);
  await cdp.evaluate(`(() => {
    __live.renderControl({ docId: 'mock-nav-dock', workspaceId: 'w-demo', version: null, versions: [1, 2] }, () => {});
    __live.keepControlLifted();
  })()`);
  await frames(cdp);

  const chevrons = `document.querySelector('[data-cw-mock-versions]')`;
  const box = async (expr: string) => (await cdp.evaluate(`(${BOX})(${expr})`)) as Box | null;
  const back = (await box(`${chevrons}.querySelector('button')`)) as Box;
  const docked = {
    dock: await box(`${SHADOW}.querySelector('.cw-dock')`),
    chevrons: await box(chevrons),
    fab: await box(`${SHADOW}.querySelector('.fab')`),
    list: await box(`${SHADOW}.querySelector('.fab-list')`),
    chevronOnTop: (await cdp.evaluate(
      `!!document.elementFromPoint(${(back[0] + back[2]) / 2}, ${(back[1] + back[3]) / 2})?.closest('[data-cw-mock-versions]')`,
    )) as boolean,
  };

  // The item is answered elsewhere and leaves the dock.
  const before = (await cdp.evaluate(`${chevrons}.getBoundingClientRect().bottom`)) as number;
  await cdp.evaluate(`(() => { ${HOST}.linkedItems = []; ${HOST}.scheduleRender(); })()`);
  await until(cdp, `!${SHADOW}.querySelector('.cw-dock')`);
  // Bounded: on a build that never lifted the chevrons they never move.
  for (let i = 0; i < 20; i++) {
    if ((await cdp.evaluate(`${chevrons}.getBoundingClientRect().bottom`)) !== before) break;
    await sleep(50);
  }
  await frames(cdp);
  const cleared = {
    dock: await box(`${SHADOW}.querySelector('.cw-dock')`),
    chevrons: await box(chevrons),
  };
  return { width, height, docked, cleared };
}

const runId = `mocknavdock${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-mock-nav-dock-'));
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
