#!/usr/bin/env bun
/**
 * The microphone an ordinary embed fetches, in a running browser.
 *
 * The injector is a few bytes in the budgeted bundle that append a script tag,
 * and nothing about that can be checked without a real origin to fetch from:
 * happy-dom refuses to load a script at all, so the unit test can only assert
 * the tag. This serves the three bundles over HTTP, loads a page that does
 * nothing but drop in the tag and the script, and measures the button that
 * appears.
 *
 * Two pages, so the reading has a control. `/bare` is the embed, which gets
 * its mic from the injector; `/control` says `window.cwMic = true` before the
 * bundle loads (which is what a served mock does through `mockup-live.js`) and
 * fetches `/widget/mic.js` from its own tag instead. The mic is mounted by the
 * same `mountVoiceLoader` either way, so the two boxes must agree: that is
 * what says the injector puts the button where an explicit mount puts it,
 * rather than somewhere of its own.
 *
 * Spawned by `embed-mic-browser.test.ts`, which reads the JSON it prints. Its
 * own process for the reason `mic-phone-driver.ts` gives: one browser launch,
 * with a cleanup that must run even when a case throws.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns was measured in a running browser.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
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
  /** The mic on the bare embed, put there by the injector. */
  injected: Box | null;
  /** The mic on the control page, fetched by a tag the page wrote itself. */
  control: Box | null;
  /** The widget's own two buttons on the bare embed, for the slot. */
  fab: Box | null;
  list: Box | null;
  /** Every script the bare embed ended up with, in order. */
  scripts: string[];
  /** The mic's hover label on the bare embed. */
  tip: string | null;
}

/** One bundle, built the way `mic-phone-driver.ts` builds its own: to a
 *  string, so nothing is written into the package's `dist`. */
function bundle(entry: string): string {
  const built = spawnSync(
    'bun',
    ['build', join(import.meta.dirname, '../src', entry), '--target=browser', '--format=iife'],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (built.status !== 0) throw new Error(`bun build ${entry} failed: ${built.stderr}`);
  return built.stdout;
}

function pageHtml(origin: string, control: boolean): string {
  // What the embedding instructions actually tell somebody to paste: one tag
  // and one script. The control adds the two lines a served mock's own
  // bundle contributes — the flag, and a tag for the mic.
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:15px/1.5 system-ui;margin:0;background:#f7f7f2}
 header{background:#2f6b3a;color:#fff;padding:18px 24px}
 main{padding:24px} #tail{height:900px}</style></head>
<body>
<header><h1>Harborlight ferry times</h1></header>
<main><div id="tail">Six sailings a day.</div></main>
<${TAG} doc-id="embed-mic" workspace-id="w-riverbend" user="Test Reviewer"
  server-url="ws://${origin}"></${TAG}>
${control ? '<script>window.cwMic = true;</script>' : ''}
<script src="/widget.iife.js"></script>
${control ? '<script src="/widget/mic.js"></script>' : ''}
</body></html>`;
}

const LOOK = `(() => {
  const sr = ${SHADOW};
  const box = (e) => {
    if (!e || getComputedStyle(e).display === 'none') return null;
    const r = e.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
  };
  const mic = sr.querySelector('.fab-mic');
  return {
    mic: box(mic),
    fab: box(sr.querySelector('.fab')),
    list: box(sr.querySelector('.fab-list:not(.fab-mic)')),
    scripts: [...document.querySelectorAll('script[src]')].map((s) => s.src),
    tip: mic ? mic.dataset.tip ?? null : null,
  };
})()`;

type Look = {
  mic: Box | null;
  fab: Box | null;
  list: Box | null;
  scripts: string[];
  tip: string | null;
};

async function load(cdp: Cdp, url: string, width: number, height: number): Promise<Look> {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 1100,
  });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  // The mic arrives over the network, after DOMContentLoaded. Polled rather
  // than slept for, and a page that never gets one still returns its look so
  // the test can say so.
  for (let i = 0; i < 60; i += 1) {
    const there = (await cdp.evaluate(`!!${SHADOW}?.querySelector('.fab-mic')`)) as boolean;
    if (there) break;
    await sleep(100);
  }
  await sleep(150);
  return (await cdp.evaluate(LOOK)) as Look;
}

const runId = `embedmic${process.pid}`;
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const stop = (proc: ChildProcess | undefined): void => {
  try {
    proc?.kill();
  } catch {}
};
try {
  const files = new Map<string, string>([
    ['/widget.iife.js', bundle('widget-iife.ts')],
    ['/widget/mic.js', bundle('mic-entry.ts')],
    ['/widget/voice.js', bundle('voice/voice-entry.ts')],
  ]);
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      const js = files.get(pathname);
      if (js) return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (pathname === '/bare' || pathname === '/control') {
        return new Response(pageHtml(`127.0.0.1:${server?.port}`, pathname === '/control'), {
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
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
  for (const [width, height] of [
    [1180, 820],
    [430, 932],
  ]) {
    const bare = await load(cdp, `${origin}/bare`, width, height);
    const control = await load(cdp, `${origin}/control`, width, height);
    readings.push({
      width,
      height,
      injected: bare.mic,
      control: control.mic,
      fab: bare.fab,
      list: bare.list,
      scripts: bare.scripts,
      tip: bare.tip,
    });
  }
  cdp.close();
  console.log(JSON.stringify(readings));
} finally {
  server?.stop(true);
  stop(browser?.proc);
  await sleep(400);
  for (const name of profilesOfRun(readdirSync(tmpdir()), runId)) {
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
    } catch {}
  }
}
process.exit(0);
