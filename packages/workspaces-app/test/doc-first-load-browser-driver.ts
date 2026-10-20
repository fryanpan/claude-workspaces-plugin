#!/usr/bin/env bun
/**
 * A doc's first load on a phone's network, in headless Chromium against a
 * real server and the real doc bundle.
 *
 * Each load is a fresh browser profile, so nothing is cached and no service
 * worker is installed: the first visit after a deploy, which is the load that
 * was slow. The throttled load goes through `throttle-relay.ts` (~9 Mbps down,
 * 150 ms round trip) with the CPU slowed four times; the unthrottled one goes
 * straight to the server. A script installed before the page's own records
 * when the doc's text first appears in `#editor`, how many bytes the page had
 * transferred by then, and when the editor itself mounted.
 *
 * `DOC_FIRST_LOAD_DIST=<dir>` serves an already-built bundle instead of
 * building this tree's, which is how the PR measured the bundle before it.
 *
 * Spawned by `doc-first-load-browser.test.ts`, which reads the JSON it prints.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';
import type { DocFirstLoadRun, DocLoad } from './doc-first-load-reading.ts';
import { PHONE_5G, measureRate, startRelay } from './throttle-relay.ts';

/** The words the reader is waiting for: the doc's last paragraph. */
const NEEDLE = 'Riverbend ferry leaves on the hour.';
const DOC = [
  '# Harborlight tide table',
  '',
  ...Array.from({ length: 40 }, (_, i) =>
    [
      `## Week ${i + 1}`,
      '',
      `High water at Saltmarsh reaches the harbour wall on day ${i + 1}; the`,
      'low-water channel stays open for small boats and the pilot launch.',
      '',
    ].join('\n'),
  ),
  NEEDLE,
  '',
].join('\n');

const step = (what: string): void => {
  process.stderr.write(`[doc-first-load-driver] ${what}\n`);
};

/** Installed before the page's own scripts: stamps the text and the editor. */
const PROBE = `(() => {
  try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}
  const bytes = () => {
    const nav = performance.getEntriesByType('navigation')[0];
    return (nav ? nav.transferSize : 0) +
      performance.getEntriesByType('resource').reduce((s, r) => s + (r.transferSize || 0), 0);
  };
  const check = () => {
    const ed = document.getElementById('editor');
    if (!ed) return;
    if (!window.__cwText && ed.textContent.includes(${JSON.stringify(NEEDLE)})) {
      window.__cwText = { at: performance.now(), bytes: bytes() };
    }
    if (!window.__cwEditor && ed.querySelector(':scope > .ProseMirror[contenteditable]')) {
      window.__cwEditor = { at: performance.now() };
    }
    if (window.__cwText && window.__cwEditor) observer.disconnect();
  };
  const observer = new MutationObserver(check);
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
})();`;

let browser: { proc: ChildProcess; profile: string } | undefined;

async function until<T>(what: string, read: () => Promise<T | null>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(100);
  }
  throw new Error(`never happened: ${what}`);
}

/** One cold load of `url` in a browser of its own. */
async function coldLoad(url: string, cpuSlowdown: number): Promise<DocLoad> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width: 430, height: 932 }, profile),
    STARTUP_TIMEOUT_MS,
    `doc-first-load-${process.pid}`,
    (started) => {
      browser = started;
    },
  );
  try {
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (cpuSlowdown > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuSlowdown });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    await cdp.send('Page.navigate', { url });
    const text = await until('the doc text', async () => {
      const v = (await cdp.evaluate('window.__cwText ?? null')) as {
        at: number;
        bytes: number;
      } | null;
      return v;
    });
    const editor = await until('the editor', async () => {
      const v = (await cdp.evaluate('window.__cwEditor ?? null')) as { at: number } | null;
      return v;
    });
    cdp.close();
    return {
      textMs: Math.round(text.at),
      bytesBeforeText: text.bytes,
      editorMs: Math.round(editor.at),
    };
  } finally {
    await stopBrowser(b.proc, b.profile);
    browser = undefined;
  }
}

/** The biggest script in the bundle: the control's known payload. */
function largestScript(dist: string): string {
  const scripts = readdirSync(dist).filter((f) => f.endsWith('.js'));
  scripts.sort((a, b) => statSync(join(dist, b)).size - statSync(join(dist, a)).size);
  const first = scripts[0];
  if (!first) throw new Error(`no scripts in ${dist}`);
  return first;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'doc-first-load-'));
  let handle: ServerHandle | undefined;
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  try {
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    let appDist = process.env.DOC_FIRST_LOAD_DIST ?? '';
    if (!appDist) {
      step('build the doc bundle');
      appDist = join(dir, 'app');
      const built = spawnSync(
        'bun',
        ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
        { encoding: 'utf8', timeout: 120_000 },
      );
      if (built.status !== 0) throw new Error(`doc bundle build failed:\n${built.stderr}`);
    }
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
    const direct = `http://127.0.0.1:${handle.port}`;
    const post = async (path: string, payload: unknown) => {
      const res = await fetch(`${direct}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const file = join(dir, 'tide-table.md');
    writeFileSync(file, DOC);
    const author = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author })) as { workspace: { id: string } }
    ).workspace.id;
    const docId = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'tide-table',
          type: 'markdown',
          sourceUrl: file,
        })
      ).docId,
    );
    const path = `/workspaces/${ws}/docs/${docId}`;

    relay = await startRelay(handle.port, PHONE_5G);
    const throttled = `http://127.0.0.1:${relay.port}`;
    step('control: the relay paces an uncompressed asset at the rate it was set to');
    const rate = await measureRate(`${throttled}/app/${largestScript(appDist)}`);

    step('cold load through the relay, CPU slowed 4x');
    const slow = await coldLoad(`${throttled}${path}`, 4);
    step('control: cold load straight to the server');
    const fast = await coldLoad(`${direct}${path}`, 1);

    const run: DocFirstLoadRun = {
      relayBitsPerSecond: Math.round(rate.bitsPerSecond),
      configuredBitsPerSecond: PHONE_5G.downBitsPerSecond,
      throttled: slow,
      unthrottled: fast,
    };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await relay?.close();
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
