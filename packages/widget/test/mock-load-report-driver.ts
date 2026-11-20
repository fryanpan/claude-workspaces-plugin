#!/usr/bin/env bun
/**
 * A served mock's load report, in headless Chromium against a real board
 * server at 1180x820. The mock shows two images from another server — a
 * stand-in for a CDN or a map's tiles — which holds each response for
 * `IMAGE_HOLD_MS`. The driver opens the mock through the board's mock route
 * and reads back the report the page filed in the board's load log.
 *
 * Spawned by `mock-load-report-browser.test.ts`, which reads the JSON it prints.
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
import { poll, step } from './draft-reload-page.ts';
import { buildWidget } from './frame-driver-kit.ts';

/** How long the other server holds each image. */
export const IMAGE_HOLD_MS = 4_000;

export interface Reading {
  holdMs: number;
  /** Image requests the other server answered: proof the mock asked for them. */
  imagesServed: number;
  report: {
    page?: unknown;
    msToBoot?: unknown;
    msToContent?: unknown;
    msToFrameStart?: unknown;
    msToFrameLoad?: unknown;
  };
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mock-load-report-'));
  let handle: ServerHandle | undefined;
  let imagesServed = 0;
  const tiles = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch() {
      await Bun.sleep(IMAGE_HOLD_MS);
      imagesServed += 1;
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    },
  });
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
    const agent = { id: 'agent-harborlight', name: 'Harborlight agent', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author: agent })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const file = join(dir, 'tides.html');
    const tile = `http://127.0.0.1:${tiles.port}`;
    writeFileSync(
      file,
      `<!doctype html><html><head><meta charset="utf-8"><title>Riverbend tides</title></head>
<body><h1>Riverbend tides</h1><p>Saltmarsh high water at six.</p>
<img src="${tile}/tile-1.png" alt="map"><img src="${tile}/tile-2.png" alt="map"></body></html>`,
    );
    const docId = String(
      (await post(`/workspaces/${ws}/docs`, { docId: 'tides', type: 'mockup', sourceUrl: file }))
        .docId,
    );
    await post(`/workspaces/${ws}/docs:attach`, { docId });

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `mock-load-report-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');

    step('open the mock');
    // Not awaited to load: the page's load waits on the held images too.
    await cdp.send('Page.navigate', { url: `${base}/workspaces/${ws}/mockups/${docId}` });
    const report = await poll(
      'the mock filed its load report',
      async () => {
        const res = await fetch(`${base}/workspaces/${ws}/load-reports`);
        const { reports } = (await res.json()) as { reports: Array<Record<string, unknown>> };
        return reports.find((r) => r.page === 'mock') ?? null;
      },
      // The frame's load comes after the hold, and the page's own deadline is 15s.
      600,
    );
    cdp.close();
    process.stdout.write(
      `\n${JSON.stringify({ holdMs: IMAGE_HOLD_MS, imagesServed, report } satisfies Reading)}\n`,
    );
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    tiles.stop(true);
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
