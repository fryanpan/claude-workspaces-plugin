#!/usr/bin/env bun
/**
 * The library chart (`core/plot-chart.ts`) in a bound `.mdx`, on the real doc
 * page in headless Chromium against a real server and the real doc bundle.
 * The doc's repository holds the chart file and `plot-spec.mjs` side by side,
 * copied byte for byte, as a site holds them. Then a second client on the
 * doc's socket writes the chart's state, and the open page is timed until it
 * redraws.
 *
 * No request leaves the machine: the server's esm.sh fetch is a fake that
 * answers the Plot address with the installed `@observablehq/plot`, bundled
 * into one module here.
 *
 * Spawned by `plot-chart-doc-browser.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — every value returned comes from the running page.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateHook } from '@claude-workspaces/core/mdx-component-state';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
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
import { type ServerHandle, createServer } from '../../server/src/server.ts';

export interface ChartReading {
  /** Bars drawn and the chart's title, as the page shows them. */
  bars: number;
  title: string;
}

export interface PlotChartDocReading {
  /** The chart as the tag's props draw it. */
  first: ChartReading;
  /** The chart after another client wrote its state, and how long that
   *  write took to reach the open page. */
  afterWrite: ChartReading;
  writeToPageMs: number;
  /** Whether the server built the tag from the copied files without an error. */
  buildError: string | null;
}

const step = (what: string): void => {
  process.stderr.write(`[plot-chart-doc-driver] ${what}\n`);
};

async function until<T>(what: string, read: () => Promise<T | null>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(50);
  }
  throw new Error(`never happened: ${what}`);
}

const PLOT_URL = 'https://esm.sh/@observablehq/plot@0.6.17';
const CORE_SRC = join(import.meta.dirname, '..', '..', 'core', 'src');

const DOC = `# Harborlight ferry

import Chart from './components/plot-chart.ts'

<Chart id="ferry" title="Ferry trips" data={{ rows: [{ town: "Harborlight", trips: 4 }, { town: "Riverbend", trips: 7 }] }} marks={[{ mark: "barY", data: "rows", options: { x: "town", y: "trips" } }]} />

Saltmarsh notes below.
`;

const NEW_ROWS = [
  { town: 'Harborlight', trips: 4 },
  { town: 'Riverbend', trips: 7 },
  { town: 'Saltmarsh', trips: 2 },
];

const READ = `(() => {
  const host = document.querySelector('#editor .mdx-live');
  const figure = host && host.querySelector('figure.plot-chart');
  if (!figure) return null;
  const error = host.querySelector('.mdx-live-error, .plot-spec-error');
  return {
    bars: figure.querySelectorAll('[aria-label="bar"] rect').length,
    title: figure.querySelector('.plot-chart-title')?.textContent ?? '',
    error: error ? error.textContent : null,
  };
})()`;

/** A client on the doc's socket: it syncs, and sends what it writes. */
function openSocket(url: string): { ydoc: Y.Doc; ready: Promise<void>; close: () => void } {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let synced: () => void = () => {};
  const ready = new Promise<void>((r) => {
    synced = r;
  });
  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
  });
  ws.addEventListener('message', (ev) => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
    if (decoding.readVarUint(dec) !== 0) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    const kind = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (kind === syncProtocol.messageYjsSyncStep2) synced();
  });
  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === ws || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });
  return { ydoc, ready, close: () => ws.close() };
}

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'plot-chart-doc-'));
  let handle: ServerHandle | undefined;
  let writer: ReturnType<typeof openSocket> | undefined;
  try {
    step('build the doc bundle and the stand-in esm.sh Plot');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`doc bundle build failed:\n${built.stderr}`);
    const plot = await Bun.build({
      entrypoints: [fileURLToPath(import.meta.resolve('@observablehq/plot'))],
      format: 'esm',
      target: 'browser',
      minify: true,
    });
    const plotModule = await plot.outputs[0]?.text();
    if (!plot.success || !plotModule) throw new Error('could not bundle @observablehq/plot');

    const repo = join(dir, 'harborlight');
    mkdirSync(join(repo, 'components'), { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'components', 'component.json'), '{}');
    for (const name of ['plot-chart.ts', 'plot-spec.mjs']) {
      copyFileSync(join(CORE_SRC, name), join(repo, 'components', name));
    }
    writeFileSync(join(repo, 'ferry.mdx'), DOC);
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
      componentFetch: async (url) =>
        url.startsWith(PLOT_URL)
          ? new Response(plotModule)
          : new Response('not here', { status: 404 }),
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
    const author = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author })) as { workspace: { id: string } }
    ).workspace.id;
    const docId = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'ferry',
          type: 'markdown',
          sourceUrl: join(repo, 'ferry.mdx'),
        })
      ).docId,
    );

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `plot-chart-doc-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
    });
    type Read = ChartReading & { error: string | null };
    step('open the doc');
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `${base}/workspaces/${ws}/docs/${docId}` });
    await loaded;
    const first = (await until('the chart drew from its props', async () => {
      const r = (await cdp.evaluate(READ)) as Read | null;
      return r && (r.bars > 0 || r.error) ? r : null;
    })) as Read;

    step('write the chart state from a second client and time the open page');
    writer = openSocket(`ws://127.0.0.1:${handle.port}/workspaces/${ws}/docs/${docId}/y`);
    await writer.ready;
    const hook = createStateHook(writer.ydoc, 'ferry', { canWrite: true });
    const wroteAt = performance.now();
    const wrote = [
      hook.set('data.rows', NEW_ROWS),
      hook.set('title', 'Ferry trips, Saltmarsh added'),
    ];
    for (const w of wrote) if (!w.ok) throw new Error(`state write refused: ${w.error}`);
    const afterWrite = (await until('the written state on the open page', async () => {
      const r = (await cdp.evaluate(READ)) as Read | null;
      return r && r.bars === NEW_ROWS.length && r.title.includes('Saltmarsh') ? r : null;
    })) as Read;
    const writeToPageMs = Math.round(performance.now() - wroteAt);
    hook.dispose();
    cdp.close();
    const reading: PlotChartDocReading = {
      first: { bars: first.bars, title: first.title },
      afterWrite: { bars: afterWrite.bars, title: afterWrite.title },
      writeToPageMs,
      buildError: first.error,
    };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    writer?.close();
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 170s');
  const b = browser;
  void (b ? stopBrowser(b.proc, b.profile) : Promise.resolve()).finally(() => process.exit(3));
}, 170_000).unref();
await main();
process.exit(0);
