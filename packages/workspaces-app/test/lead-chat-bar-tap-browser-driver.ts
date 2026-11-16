#!/usr/bin/env bun
/**
 * Taps the lead chat's bar while its rows redraw, in headless Chrome, and
 * prints how many clicks the bar took for each kind of redraw.
 *
 * Run by `lead-chat-bar-tap-browser.test.ts`; a separate Bun process because
 * the page is bundled by `Bun.build` and served by `Bun.serve`, and vitest
 * runs under node. The redraw goes in between the press and the release, the
 * way a transcript update lands under a finger on an iPad.
 */
import { join } from 'node:path';
import {
  Cdp,
  launchChrome,
  pageSocketUrl,
  sleep,
  stopBrowser,
  withTimeout,
} from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
  resolveRunId,
} from '../../../scripts/ui-shot-lib.ts';

export interface BarTapCase {
  name: string;
  clicks: number;
}

/** What is on the bar at the press, and what it is redrawn to before the release. */
const CASES: Array<{ name: string; before: object; after: object }> = [
  { name: 'Listening… redrawn unchanged', before: {}, after: {} },
  { name: 'Listening… to the first heard word', before: {}, after: { heard: 'the' } },
  { name: 'heard words growing', before: { heard: 'the' }, after: { heard: 'the ferry task' } },
];

const built = await Bun.build({
  entrypoints: [join(import.meta.dir, 'lead-chat-bar-tap-page.ts')],
  target: 'browser',
  format: 'esm',
});
if (!built.success) throw new Error(built.logs.map(String).join('\n'));
const page = (await built.outputs[0]?.text()) ?? '';
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    if (new URL(req.url).pathname === '/page.js') {
      return new Response(page, { headers: { 'content-type': 'text/javascript' } });
    }
    return new Response(
      '<!doctype html><meta charset="utf-8"><body><script type="module" src="/page.js"></script></body>',
      { headers: { 'content-type': 'text/html' } },
    );
  },
});
let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
let cdp: Cdp | undefined;
const out: BarTapCase[] = [];
try {
  browser = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
    STARTUP_TIMEOUT_MS,
    `${resolveRunId()}bartap`,
    (b) => {
      browser = b;
    },
  );
  const c = await Cdp.connect(await pageSocketUrl(browser.port, STARTUP_TIMEOUT_MS));
  cdp = c;
  await c.send('Page.enable');
  const loaded = c.once('Page.loadEventFired');
  await c.send('Page.navigate', { url: `http://127.0.0.1:${server.port}` });
  await withTimeout(loaded, 20_000, 'page load');
  for (let i = 0; !(await c.evaluate(`typeof window.cwBar === 'object'`)); i++) {
    if (i > 300) throw new Error('the page bundle never loaded');
    await sleep(50);
  }
  for (const k of CASES) {
    await c.evaluate(`window.cwBar.draw(${JSON.stringify(k.before)})`);
    const at = (await c.evaluate(`(() => {
      const r = document.querySelector('.lc-bar-line').getBoundingClientRect();
      return { x: r.left + 20, y: r.top + r.height / 2 };
    })()`)) as { x: number; y: number };
    const before = (await c.evaluate('window.cwBar.clicks()')) as number;
    const mouse = (type: string) =>
      c.send('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1 });
    await mouse('mousePressed');
    await c.evaluate(`window.cwBar.draw(${JSON.stringify(k.after)})`);
    await mouse('mouseReleased');
    // The click is dispatched with the release; one evaluate after it reads it.
    const clicks = ((await c.evaluate('window.cwBar.clicks()')) as number) - before;
    out.push({ name: k.name, clicks });
  }
} finally {
  cdp?.close();
  if (browser) await stopBrowser(browser.proc, browser.profile);
  server.stop(true);
}
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
