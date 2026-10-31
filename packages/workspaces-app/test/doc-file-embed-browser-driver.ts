#!/usr/bin/env bun
/**
 * A doc whose `::html{src="map/index.html"}` line frames a page from the
 * doc's own folder, opened on the real doc page in headless Chromium against
 * a real server and the real doc bundle.
 *
 * The page beside the doc loads a relative stylesheet, a relative script, and
 * from that script fetches a relative JSON file. It reports what it saw to the
 * doc page with one `postMessage`, which the doc page records: the colour its
 * heading was drawn in, the JSON it read, its own origin, and whether it
 * could read the doc page's DOM.
 *
 * Spawned by `doc-file-embed-browser.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — every value returned comes from the running page.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { type ServerHandle, createServer } from '../../server/src/server.ts';

export interface FileEmbedReading {
  /** The frame's `src` and `sandbox`, as the doc page drew them. */
  frameSrc: string | null;
  sandbox: string | null;
  /** What the framed page reported, or null when it never did. */
  report: {
    scriptRan: boolean;
    headingColor: string;
    json: unknown;
    fetchError: string | null;
    origin: string;
    parentReadable: boolean;
    hash: string;
  } | null;
}

const step = (what: string): void => {
  process.stderr.write(`[doc-file-embed-driver] ${what}\n`);
};

async function until<T>(what: string, read: () => Promise<T | null>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(100);
  }
  throw new Error(`never happened: ${what}`);
}

const PAGE = `<!doctype html>
<html><head>
<link rel="stylesheet" href="style.css">
<script src="app.js" defer></script>
</head><body><h1>Harborlight ferry map</h1></body></html>`;

const STYLE = 'h1 { color: rgb(12, 34, 56); }';

const APP = `
window.harborlightScript = true;
(async () => {
  let json = null;
  let fetchError = null;
  try {
    const res = await fetch('data/ferry.json');
    json = await res.json();
  } catch (e) {
    fetchError = String(e);
  }
  let parentReadable = false;
  try {
    parentReadable = !!window.parent.document.body;
  } catch {}
  window.parent.postMessage({
    type: 'cw-file-embed-test',
    scriptRan: window.harborlightScript === true,
    headingColor: getComputedStyle(document.querySelector('h1')).color,
    json,
    fetchError,
    origin: String(self.origin),
    parentReadable,
    hash: location.hash,
  }, '*');
})();`;

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'doc-file-embed-'));
  let handle: ServerHandle | undefined;
  try {
    step('build the doc bundle');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`doc bundle build failed:\n${built.stderr}`);
    const docDir = join(dir, 'harborlight');
    mkdirSync(join(docDir, 'map', 'data'), { recursive: true });
    writeFileSync(
      join(docDir, 'ferry.md'),
      '# Harborlight ferry\n\n::html{src="map/index.html"}\n\nRiverbend notes below.\n',
    );
    writeFileSync(join(docDir, 'map', 'index.html'), PAGE);
    writeFileSync(join(docDir, 'map', 'style.css'), STYLE);
    writeFileSync(join(docDir, 'map', 'app.js'), APP);
    writeFileSync(join(docDir, 'map', 'data', 'ferry.json'), '{"route":"Saltmarsh"}');
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
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
    const author = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author })) as { workspace: { id: string } }
    ).workspace.id;
    const docId = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'ferry',
          type: 'markdown',
          sourceUrl: join(docDir, 'ferry.md'),
        })
      ).docId,
    );

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `doc-file-embed-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.cwFileEmbed = null;
        try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}
        window.addEventListener('message', (e) => {
          if (e.data && e.data.type === 'cw-file-embed-test') window.cwFileEmbed = e.data;
        });`,
    });
    step('open the doc');
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `${base}/workspaces/${ws}/docs/${docId}` });
    await loaded;
    const frame = (await until('the frame drawn', async () =>
      cdp.evaluate(`(() => {
        const f = document.querySelector('#editor iframe[data-embed-files]');
        return f ? { src: f.getAttribute('src'), sandbox: f.getAttribute('sandbox') } : null;
      })()`),
    )) as { src: string | null; sandbox: string | null };
    step('wait for the framed page to report');
    const report = (await until('the framed page to report', async () =>
      cdp.evaluate('window.cwFileEmbed'),
    ).catch(() => null)) as FileEmbedReading['report'];
    cdp.close();
    const reading: FileEmbedReading = { frameSrc: frame.src, sandbox: frame.sandbox, report };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
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
