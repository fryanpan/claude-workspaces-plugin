#!/usr/bin/env bun
/**
 * A review item on an attached app's page, opened from Home in headless
 * Chromium against a real board server with the real board client.
 *
 * An agent files a declared ask on the words of `/transportation/bike/`. The
 * reader opens Home, taps the row, and taps the card's link to where the item
 * lives. That has to land on the bike page, not the markdown editor or the
 * app's root, with the item open in the frame: a review item opens in the
 * widget's dock sheet (`widget-dock.ts`), not at its pin.
 *
 * Spawned by `home-app-link-browser.test.ts`, which reads the JSON it prints.
 * `HOME_APP_LINK_SHOTS=<dir>` also writes screenshots at 1180x820 and 430x932.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  buildWidget,
  frameSessions,
  frameSurface,
  pageSurface,
  poll,
  reload,
  tap,
} from './frame-driver-kit.ts';

export interface HomeAppLinkRun {
  /** Where the tap landed, as a path on the board, once the frame dropped `thread`. */
  landed: string;
  /** The page the widget in the frame read. */
  key: string;
  /** The opened item's text (the dock's sheet), at each width. */
  opened: string[];
  threadId: string;
}

const SHADOW = `document.querySelector('claude-feedback-widget')?.shadowRoot`;
const KEY = `document.querySelector('claude-feedback-widget')?.getContext().url ?? null`;
/** A review item opens in the dock's sheet; any other thread at its pin's popover. */
const OPENED = `(${SHADOW}?.querySelector('.cw-dock-scrim, .thread-popover')?.textContent ?? null)`;
const ASK = 'Are the protected lanes right?';

const page = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Harborlight</title>
<style>body{font:16px/1.5 system-ui;margin:0;padding:40px 60px}</style></head><body>${body}</body></html>`;

const step = (what: string): void => {
  process.stderr.write(`[home-app-link-driver] ${what}\n`);
};

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'home-app-link-'));
  const shots = process.env.HOME_APP_LINK_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  let handle: ServerHandle | undefined;
  let dev: ReturnType<typeof Bun.serve> | undefined;
  try {
    const dist = join(dir, 'widget');
    await buildWidget(dist);
    step('build the board client');
    const appPkg = join(import.meta.dirname, '../../workspaces-app');
    // Its own folder: the build deletes its output first, so a shared one
    // races any other driver building at the same time (scripts/build.ts).
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(appPkg, 'scripts', 'build.ts'), '--outdir', appDist],
      {
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    if (built.status !== 0) throw new Error(`board client build failed:\n${built.stderr}`);
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: dist,
      markdownAppDistDir: appDist,
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
    const agent = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author: agent })) as {
        workspace: { id: string };
      }
    ).workspace.id;

    dev = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) =>
        new Response(
          new URL(req.url).pathname === '/transportation/bike/'
            ? page('<h1 id="bike">Riverbend bike lanes</h1>')
            : page('<h1>Harborlight home</h1>'),
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
    });
    const app = String(
      (
        await post(`/workspaces/${ws}/apps`, {
          docId: 'harborlight-app',
          origin: `http://127.0.0.1:${dev.port}/`,
        })
      ).docId,
    );
    const made = (await post(`/workspaces/${ws}/docs/${app}/threads/by_find`, {
      author: agent,
      text: ASK,
      find: 'Riverbend bike lanes',
      path: '/transportation/bike/',
      review: { shape: 'review', headline: ASK },
    })) as { thread: { id: string } };

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `home-app-link-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // A returning reader: a first arrival gets the name prompt over Home.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
    });
    const sessions = await frameSessions(cdp);
    const top = pageSurface(cdp);
    const frame = frameSurface(cdp, sessions, "document.getElementById('bike')");
    const size = (width: number, height: number) =>
      cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width <= 1100,
      });
    const shot = async (name: string) => {
      if (!shots) return;
      const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
      writeFileSync(join(shots, name), Buffer.from(png.data, 'base64'));
    };

    const fromHome = async (width: number): Promise<{ landed: string; popover: string }> => {
      await reload(cdp, `${base}/workspaces/${ws}/home`);
      await shot(`home-${width}.png`);
      step('tap the row on Home');
      await tap(cdp, top, `document.querySelector('.board-review-row')`, 'the Home row');
      step("tap the card's link to where the item lives");
      const left = cdp.once('Page.loadEventFired');
      await tap(cdp, top, `document.querySelector('.board-walk-where-link')`, 'the where link');
      await left;
      step(`landed on ${String(await top.eval('location.pathname + location.search'))}`);
      const popover = String(
        await poll('the thread open on the page', async () => {
          const text = (await frame.eval(OPENED)) as string | null;
          return text?.includes(ASK) ? text : null;
        }),
      );
      const landed = String(await top.eval('location.pathname + location.search'));
      await shot(`page-${width}.png`);
      return { landed, popover };
    };

    await size(1180, 820);
    const wide = await fromHome(1180);
    const key = String(await frame.eval(KEY));
    await size(430, 932);
    const narrow = await fromHome(430);
    cdp.close();

    const run: HomeAppLinkRun = {
      landed: wide.landed,
      key,
      opened: [wide.popover, narrow.popover],
      threadId: made.thread.id,
    };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    dev?.stop(true);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 150s');
  const b = browser;
  void (b ? stopBrowser(b.proc, b.profile) : Promise.resolve()).finally(() => process.exit(3));
}, 150_000).unref();
await main();
process.exit(0);
