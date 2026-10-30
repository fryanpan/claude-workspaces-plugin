#!/usr/bin/env bun
/**
 * A reader on an inner screen of a mock, and the agent saving the mock's next
 * round, in headless Chromium against a real board server.
 *
 * The mock is a two-tab page written the way agents write them: a top-level
 * `const`, and its start-up in a `DOMContentLoaded` listener that draws the
 * tab the last round kept (`window.cwRoundState`, which it fills on
 * `cw-round-leaving`). The reader opens it at `?view=list#notes`, taps the
 * second tab and scrolls down; the driver rewrites the file and waits for the
 * round to swap in, then reads what the frame shows.
 *
 * Before `mockup-live-state.ts` the new round's start-up was never called,
 * because a page that does not reload never fires `DOMContentLoaded` again,
 * so the reader was put back on the first tab.
 *
 * Spawned by `mock-swap-state.test.ts`, which reads the JSON it prints.
 */
// audit: no-text
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, launchChrome, pageSocketUrl, stopBrowser } from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import {
  frameSessions,
  frameSurface,
  navigate,
  poll,
  ready,
  step,
  tap,
} from './draft-reload-page.ts';
import { buildWidget } from './frame-driver-kit.ts';

export interface Shown {
  round: string | null;
  tab: string | null;
  search: string;
  hash: string;
  scrollY: number;
}

export interface Reading {
  /** The frame after the reader's tap and scroll, before the save. */
  before: Shown;
  /** The frame once round two is on screen. */
  after: Shown;
}

/** `id="title"` is what `frameSurface` looks for to find the mock's frame. */
const mockPage = (round: number) => `<!doctype html><html><head><meta charset="utf-8">
<title>Riverbend permits</title>
<style>body{margin:0;font:16px system-ui} nav button{padding:12px 20px} .tall{height:3000px}</style></head>
<body><h1 id="title">Riverbend permits</h1><p id="round">Round ${round}</p>
<nav><button id="tab-open">Open</button><button id="tab-closed">Closed</button></nav>
<p id="screen">Open permits</p><div class="tall"></div>
<script>
const TABS = { open: 'Open permits', closed: 'Closed permits' };
let tab = 'open';
function show(t) { tab = t; document.getElementById('screen').textContent = TABS[t]; }
window.addEventListener('cw-round-leaving', (e) => { e.detail.state = { tab }; });
document.addEventListener('DOMContentLoaded', () => {
  show(window.cwRoundState?.tab ?? 'open');
  for (const t of Object.keys(TABS)) {
    document.getElementById('tab-' + t).addEventListener('click', () => show(t));
  }
});
</script></body></html>`;

const SHOWN = `({
  round: document.getElementById('round')?.textContent ?? null,
  tab: document.getElementById('screen')?.textContent ?? null,
  search: location.search,
  hash: location.hash,
  scrollY: Math.round(scrollY),
})`;

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mock-swap-state-'));
  let handle: ServerHandle | undefined;
  try {
    const dist = join(dir, 'widget');
    await buildWidget(dist);
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: dist,
      requireSignInToWrite: false,
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const post = async (path: string, payload: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const agent = { id: 'agent-riverbend', name: 'Riverbend permits', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Riverbend', author: agent })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const file = join(dir, 'permits.html');
    writeFileSync(file, mockPage(1));
    const id = String(
      (await post(`/workspaces/${ws}/docs`, { docId: 'permits', type: 'mockup', sourceUrl: file }))
        .docId,
    );
    await post(`/workspaces/${ws}/docs:attach`, { docId: id });

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `mock-swap-state-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const sessions = await frameSessions(cdp);
    const frame = frameSurface(cdp, sessions);

    step('open the mock at an address with a query and a hash');
    await navigate(cdp, `${base}/workspaces/${ws}/mockups/${id}?view=list#notes`);
    await ready(frame);
    step('tap the second tab, then scroll down');
    await tap(cdp, frame, `document.getElementById('tab-closed')`, 'the Closed tab');
    await poll('the Closed tab on screen', () =>
      frame.eval(`document.getElementById('screen').textContent === 'Closed permits' || null`),
    );
    await frame.eval('window.scrollTo(0, 900)');
    const before = (await frame.eval(SHOWN)) as Shown;

    step('the agent saves round two');
    writeFileSync(file, mockPage(2));
    await poll('round two on screen', () =>
      frame.eval(`document.getElementById('round')?.textContent === 'Round 2' || null`),
    );
    const after = (await frame.eval(SHOWN)) as Shown;
    cdp.close();
    process.stdout.write(`\n${JSON.stringify({ before, after } satisfies Reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

// A driver that never finishes holds a browser open; the test's own spawn
// timeout is longer than this.
setTimeout(() => {
  step('gave up after 100s');
  const b = browser;
  void (b ? stopBrowser(b.proc, b.profile) : Promise.resolve()).finally(() => process.exit(3));
}, 100_000).unref();
await main();
process.exit(0);
