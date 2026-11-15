#!/usr/bin/env bun
/**
 * Drives an app made by `bun run new-app` in headless Chromium: sign in on
 * the app's own form, open one doc in two tabs, type in the first and read
 * the second. Prints one JSON line, an `AppKitBrowserReading`.
 *
 * Run by `scripts/app-kit-browser.test.ts`, which gates it on
 * `chromeForSuite()`; never run it from a test that has not.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBuiltApp, startApp } from '../../../scripts/app-kit-harness.ts';
import { Cdp, launchChrome, pageSocketUrl, stopBrowser } from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { waitFor } from './wait-for.ts';

export interface AppKitBrowserReading {
  /** Where the sign-in form sent the browser. */
  afterSignIn: string;
  /** Each tab's status line once its doc socket synced. */
  statuses: [string, string];
  /** What the second tab's box held after the first tab typed. */
  secondTabText: string;
  /** The theme's brand colour, as the page computed it. Empty if unthemed. */
  brandColor: string;
  /** Whether the page defined the Web Awesome button it renders. */
  buttonDefined: boolean;
  errors: string[];
}

const TYPED = 'typed in tab one';

const parent = mkdtempSync(join(tmpdir(), 'app-kit-browser-'));
const app = await startApp(makeBuiltApp(parent), join(parent, 'data'));
const errors: string[] = [];

/** The last value `read` gave: the one `ok` accepted, or, after ten
 *  seconds, the one the test will report as wrong. */
async function poll<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let last = await read();
  await waitFor(async () => ok((last = await read())), { timeout: 10_000 }).catch(() => {});
  return last;
}

async function tab(port: number, url?: string): Promise<Cdp> {
  let ws: string;
  if (url === undefined) ws = await pageSocketUrl(port, STARTUP_TIMEOUT_MS);
  else {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
    });
    ws = ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
  }
  const cdp = await Cdp.connect(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.exceptionThrown', (p) => errors.push(JSON.stringify(p).slice(0, 300)));
  return cdp;
}

async function open(cdp: Cdp, url: string): Promise<void> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
}

const status = (cdp: Cdp) =>
  poll(
    async () => String(await cdp.evaluate(`document.getElementById('status')?.textContent ?? ''`)),
    (s) => s === 'Live',
  );

let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
try {
  browser = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
    STARTUP_TIMEOUT_MS,
    `app-kit-browser-${process.pid}`,
  );
  const one = await tab(browser.port);
  await open(one, `${app.base}/auth/sign-in`);
  await one.evaluate(`document.querySelector('input[name=name]').value = 'Alice'`);
  const signedIn = one.once('Page.loadEventFired');
  await one.evaluate(`document.querySelector('form').requestSubmit()`);
  await signedIn;
  const afterSignIn = String(await one.evaluate('location.pathname'));

  const doc = `${app.base}/docs/harborlight`;
  await open(one, doc);
  const two = await tab(browser.port, doc);
  await poll(
    async () => String(await two.evaluate('document.readyState')),
    (s) => s === 'complete',
  );
  const statuses: [string, string] = [await status(one), await status(two)];

  await one.evaluate(`document.getElementById('body').focus()`);
  await one.send('Input.insertText', { text: TYPED });
  const secondTabText = await poll(
    async () => String(await two.evaluate(`document.getElementById('body').value`)),
    (v) => v === TYPED,
  );
  const brandColor = String(
    await one.evaluate(
      `getComputedStyle(document.documentElement).getPropertyValue('--wa-color-brand-50').trim()`,
    ),
  );
  const buttonDefined = Boolean(await one.evaluate(`!!customElements.get('wa-button')`));

  const reading: AppKitBrowserReading = {
    afterSignIn,
    statuses,
    secondTabText,
    brandColor,
    buttonDefined,
    errors,
  };
  console.log(JSON.stringify(reading));
} finally {
  if (browser) await stopBrowser(browser.proc, browser.profile);
  await app.stop();
  rmSync(parent, { recursive: true, force: true });
}
