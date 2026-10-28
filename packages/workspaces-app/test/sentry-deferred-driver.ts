#!/usr/bin/env bun
/**
 * A page's own script runs without waiting for `/app/sentry.js`, and an error
 * it throws while booting still reaches Sentry — in headless Chromium, with
 * the real head tags (`sentryHeadTags`) and the real built Sentry entry.
 *
 * The server here is a stand-in for the box AND for Sentry's ingest. It holds
 * the Sentry script's response until the page's own script says it ran, or
 * until a ceiling passes. Under the old markup — a plain module script ahead
 * of the page's — the page's script cannot run first, so the hold only ends at
 * the ceiling and `pageRanFirst` reads false. The page's script then throws,
 * and the envelope that arrives at the stand-in ingest is what `errorReported`
 * reads.
 *
 * Spawned by `sentry-deferred-browser.test.ts`, which reads the JSON this
 * prints last.
 */
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  Cdp,
  launchChrome,
  pageSocketUrl,
  sleep,
  stopBrowser,
} from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { sentryHeadTags } from '../../server/src/browser-sentry.ts';

export interface SentryDeferredRun {
  /** The page's script reported that it ran while the Sentry script was held. */
  pageRanFirst: boolean;
  /** An envelope carrying the boot error's message reached the ingest. */
  errorReported: boolean;
}

/** What the page's script throws at the top level, before anything else. */
export const BOOT_ERROR = 'Riverbend boot failure';

/** How long the Sentry script is held when the page's script never reports. */
const HOLD_CEILING_MS = 5_000;

const step = (what: string): void => {
  process.stderr.write(`[sentry-deferred-driver] ${what}\n`);
};

async function main(): Promise<void> {
  step('build the Sentry entry');
  const built = await Bun.build({
    entrypoints: [join(import.meta.dirname, '..', 'src', 'sentry-boot.ts')],
    target: 'browser',
    format: 'esm',
    splitting: false,
    minify: true,
    define: { __LF_BUILD_ID__: JSON.stringify('test') },
  });
  const sentryJs = await built.outputs[0]?.text();
  if (!built.success || !sentryJs) throw new Error('sentry build failed');

  let pageRan = false;
  let pageRanFirst = false;
  let sentryServed = false;
  let releasePage: (() => void) | null = null;
  const envelopes: string[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === '/') {
        // An invented key on a loopback ingest: nothing leaves this machine.
        const dsn = `http://harborlightkey@127.0.0.1:${server.port}/0`;
        const head = sentryHeadTags({ dsn }, 'doc');
        return new Response(
          `<!doctype html><html><head>${head}<script type="module" src="/page.js"></script></head><body><p>Saltmarsh</p></body></html>`,
          { headers: { 'content-type': 'text/html' } },
        );
      }
      if (pathname === '/page.js') {
        return new Response(
          `fetch('/booted', { method: 'POST' }); throw new Error(${JSON.stringify(BOOT_ERROR)});`,
          { headers: { 'content-type': 'text/javascript' } },
        );
      }
      if (pathname === '/booted') {
        pageRan = true;
        if (!sentryServed) pageRanFirst = true;
        releasePage?.();
        return new Response('ok');
      }
      if (pathname === '/app/sentry.js') {
        if (!pageRan) {
          await Promise.race([
            new Promise<void>((r) => {
              releasePage = r;
            }),
            sleep(HOLD_CEILING_MS),
          ]);
        }
        sentryServed = true;
        return new Response(sentryJs, { headers: { 'content-type': 'text/javascript' } });
      }
      if (pathname === '/api/0/envelope/') {
        envelopes.push(await req.text());
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    },
  });

  const browsers: Array<{ proc: ChildProcess; profile: string }> = [];
  try {
    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `sentry-deferred-${process.pid}`,
      (started) => {
        browsers.push(started);
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    step('open the page');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/` });
    const end = Date.now() + 20_000;
    const reported = (): boolean => envelopes.some((e) => e.includes(BOOT_ERROR));
    while (!reported() && Date.now() < end) await sleep(100);
    cdp.close();
    const run: SentryDeferredRun = { pageRanFirst, errorReported: reported() };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    for (const b of browsers) await stopBrowser(b.proc, b.profile);
    server.stop(true);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
