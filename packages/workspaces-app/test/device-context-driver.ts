#!/usr/bin/env bun
/**
 * Drives `syncDeviceContext` in headless Chrome with Chrome's own geolocation
 * permission set over CDP, and prints one JSON reading per scenario.
 *
 * Run by `device-context-browser.test.ts`; it is a separate Bun process
 * because the page is served by `Bun.serve` and bundled by `Bun.build`, and
 * vitest runs under node. The page is the SHIPPED module, bundled from source,
 * re-exported onto `window` — not a copy of it.
 *
 * Each scenario gets a fresh browser, so a permission or a stored answer from
 * one cannot leak into the next. Every scenario loads the page twice in that
 * browser (a reload, same origin, same profile), which is the "second board
 * load" the prompt must never reappear on.
 *
 * `echo` is a route on the test server that answers with the Cookie header it
 * received: the reading proves the rounded fix rides a real same-origin
 * request, which is how the server gets it.
 */
import { join } from 'node:path';
import {
  Cdp,
  launchChrome,
  pageSocketUrl,
  stopBrowser,
  withTimeout,
} from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
  resolveRunId,
} from '../../../scripts/ui-shot-lib.ts';

type Setting = 'granted' | 'denied' | 'prompt';

const SRC = join(import.meta.dir, '../src/device-context.ts');

async function bundle(): Promise<string> {
  const entry = join(process.env.TMPDIR ?? '/tmp', `device-context-entry-${process.pid}.ts`);
  await Bun.write(
    entry,
    [
      `import { syncDeviceContext, browserDeviceEnv } from ${JSON.stringify(SRC)};`,
      // Count the calls that could show a prompt, around the real API.
      'const geo = navigator.geolocation;',
      'const real = geo.getCurrentPosition.bind(geo);',
      "window.__calls = Number(sessionStorage.getItem('calls') ?? 0);",
      'geo.getCurrentPosition = (...a) => {',
      "  window.__calls++; sessionStorage.setItem('calls', String(window.__calls));",
      '  return real(...a);',
      '};',
      'window.__sync = (mayAsk) => syncDeviceContext(browserDeviceEnv(localStorage), { mayAsk });',
      '',
    ].join('\n'),
  );
  const built = await Bun.build({ entrypoints: [entry], target: 'browser' });
  if (!built.success) throw new Error(built.logs.map(String).join('\n'));
  return (await built.outputs[0]?.text()) ?? '';
}

async function scenario(js: string, setting: Setting): Promise<Record<string, unknown>> {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/echo') return new Response(req.headers.get('cookie') ?? '');
      if (url.pathname === '/app.js') {
        return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      }
      return new Response('<!doctype html><script src="/app.js"></script>', {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  let cdp: Cdp | undefined;
  try {
    browser = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `${resolveRunId()}geo${setting}`,
      (b) => {
        browser = b;
      },
    );
    cdp = await Cdp.connect(await pageSocketUrl(browser.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    // Browser.setPermission is served on the page session too; `prompt` is
    // Chrome's own default and is set explicitly so the reading names it.
    await cdp.send('Browser.setPermission', {
      permission: { name: 'geolocation' },
      setting,
      origin,
    });
    await cdp.send('Emulation.setGeolocationOverride', {
      latitude: 10.123456,
      longitude: -20.345678,
      accuracy: 5,
    });
    const load = async () => {
      const loaded = cdp!.once('Page.loadEventFired');
      await cdp!.send('Page.navigate', { url: origin });
      await withTimeout(loaded, 20_000, 'page load');
      return (await cdp!.evaluate(
        `(async () => {
          const permission = (await navigator.permissions.query({ name: 'geolocation' })).state;
          const outcome = await window.__sync(true);
          const echoed = await (await fetch('/echo')).text();
          return { permission, outcome, calls: window.__calls, stored: localStorage.getItem('cw.geo.answer'), cookie: document.cookie, echoed };
        })()`,
      )) as Record<string, unknown>;
    };
    const first = await load();
    const second = await load();
    return { setting, first, second };
  } finally {
    cdp?.close();
    if (browser) await stopBrowser(browser.proc, browser.profile);
    server.stop(true);
  }
}

const js = await bundle();
const readings = [];
for (const setting of (process.argv[2] ?? 'granted,denied,prompt').split(',') as Setting[]) {
  readings.push(await scenario(js, setting));
}
process.stdout.write(`${JSON.stringify(readings)}\n`);
process.exit(0);
