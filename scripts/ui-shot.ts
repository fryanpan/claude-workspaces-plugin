#!/usr/bin/env bun
/**
 * Headless UI check: load a URL in Chrome at an exact viewport, screenshot it,
 * optionally evaluate a JS probe, print one JSON summary — and never touch a
 * browser window a person is using.
 *
 *   bun run ui:shot --url http://127.0.0.1:8787/ --preset phone --out /tmp/board-430.png
 *   bun run ui:shot --url http://127.0.0.1:8787/ --size 1366x1024 \
 *       --wait-for '#shell' --eval 'document.querySelector("#shell").getBoundingClientRect().toJSON()'
 *
 * Flags (also `--help`):
 *   --url <url>            required; a data: URL works for self-contained probes
 *   --preset ipad|phone    1180x820 (default) or 430x932 — docs/product/design-mobile.md
 *   --size WxH             any viewport instead of a preset
 *   --out <png>            screenshot path; parents are created
 *   --eval <expr>          JS expression evaluated in the page, printed as `result`
 *   --eval-file <path>     the expression from a file (multi-line probes)
 *   --wait-for <selector>  poll until document.querySelector matches
 *   --settle <ms>          quiet time after load / wait-for (default 1000)
 *   --timeout <ms>         ceiling for load + wait-for (default 15000)
 *   --full-page            capture beyond the viewport
 *   --mobile|--no-mobile   touch emulation; default on at width <= 1100 (the mobile tier)
 *   --scale <n>            deviceScaleFactor (default 1)
 *   --chrome <bin>         Chrome binary; else $CW_CHROME_BIN; else the /Applications path
 *
 * $CW_CHROME_ARGS adds launch flags (CI containers want
 * `--no-sandbox --disable-dev-shm-usage`); unset on a laptop, so the sandbox
 * stays on there.
 *
 * Why this exists. Resizing a real Chrome window cannot reach a phone
 * viewport (Chrome floors the window near 500px) and every attempt to drive a
 * real window has landed in the owner's own browser. `--headless=new` with a
 * throwaway `--user-data-dir` under the OS temp dir is a separate browser
 * instance: no shared profile, no shared window, no tab anyone can see.
 * `Emulation.setDeviceMetricsOverride` sets the viewport exactly, so 430 is
 * 430.
 *
 * Two measured failures this script is shaped around:
 *   - devicePixelRatio is pinned (default 1) and REPORTED in the summary. In a
 *     shared browser the same page measured two different scrollbar widths
 *     across runs and the discriminator was zoom (learnings.md "The
 *     scrollbar's width in CSS px depends on browser ZOOM").
 *   - `--hide-scrollbars` is load-bearing: a classic scrollbar eats ~15px of
 *     LAYOUT width (clientWidth 415 at a 430 viewport). iOS uses overlay
 *     scrollbars that take none, so hiding it is what models the device.
 *
 * Cleanup is unconditional — killed process, removed profile, on success, on
 * error and on SIGINT/SIGTERM/SIGHUP. The mechanics, and the stale profiles
 * that taught them, are in `scripts/headless-chrome.ts`, which also holds the
 * CDP client so `scripts/client-boot-check.ts` drives the same browser rather
 * than a second copy of it. The profile directory carries a run id
 * (CW_UI_SHOT_RUN_ID, else the pid), so a leftover names the run that leaked it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type Browser,
  Cdp,
  killAndRemove,
  launchChrome,
  pageSocketUrl,
  sleep,
  withTimeout,
} from './headless-chrome.ts';
import {
  type ShotOptions,
  USAGE,
  UsageError,
  chromeLaunchArgs,
  parseArgs,
  resolveChromeBin,
  resolveRunId,
} from './ui-shot-lib.ts';

const log = (msg: string) => process.stderr.write(`ui-shot: ${msg}\n`);

async function shoot(o: ShotOptions, cdp: Cdp): Promise<Record<string, unknown>> {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: o.width,
    height: o.height,
    deviceScaleFactor: o.scale,
    mobile: o.mobile,
  });
  if (o.mobile) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });

  const started = Date.now();
  const loaded = cdp.once('Page.loadEventFired');
  const nav = await cdp.send('Page.navigate', { url: o.url });
  if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
  await withTimeout(loaded, o.timeoutMs, 'page load');

  if (o.waitFor) {
    const probe = `!!document.querySelector(${JSON.stringify(o.waitFor)})`;
    const deadline = started + o.timeoutMs;
    while (!(await cdp.evaluate(probe))) {
      if (Date.now() > deadline) {
        throw new Error(`--wait-for ${JSON.stringify(o.waitFor)} never matched`);
      }
      await sleep(100);
    }
  }
  await sleep(o.settleMs);

  const summary: Record<string, unknown> = {
    url: o.url,
    viewport: { width: o.width, height: o.height, mobile: o.mobile },
    page: await cdp.evaluate(
      '({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, ' +
        'devicePixelRatio: window.devicePixelRatio, clientWidth: document.documentElement.clientWidth, ' +
        'scrollWidth: document.documentElement.scrollWidth, title: document.title })',
    ),
  };

  if (o.eval !== undefined) summary.result = await cdp.evaluate(o.eval);

  if (o.out) {
    const shot = (await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: o.fullPage,
    })) as { data: string };
    mkdirSync(dirname(o.out), { recursive: true });
    writeFileSync(o.out, Buffer.from(shot.data, 'base64'));
    summary.screenshot = o.out;
  }
  return summary;
}

async function main(argv: string[]): Promise<number> {
  let o: ShotOptions;
  try {
    o = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      if (e.message) process.stderr.write(`ui-shot: ${e.message}\n\n`);
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
    throw e;
  }
  const bin = resolveChromeBin(o.chrome);
  const runId = resolveRunId();

  let browser: Browser | undefined;
  let cdp: Cdp | undefined;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      cdp?.close();
    } catch {}
    if (browser) killAndRemove(browser.proc, browser.profile);
  };
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('exit', cleanup);

  try {
    browser = await launchChrome(
      bin,
      (profile) => chromeLaunchArgs(o, profile),
      o.timeoutMs,
      runId,
      (b) => {
        browser = b;
      },
    );
    cdp = await Cdp.connect(await pageSocketUrl(browser.port, o.timeoutMs));
    const summary = await shoot(o, cdp);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } finally {
    cleanup();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      log(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
