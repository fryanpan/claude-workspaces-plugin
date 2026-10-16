#!/usr/bin/env bun
/**
 * A doc page with the server gone, in headless Chromium against a real server
 * and the real doc bundle.
 *
 * The reader opens a doc, the server stops (the network is cut), and the
 * reader reloads: the page has to show the doc from this browser's copy. They
 * type a sentence, reload again still offline, and the sentence has to still
 * be there. Then the server comes back on the same port and data dir, and the
 * sentence has to reach the doc's file on disk with no further action.
 *
 * Spawned by `doc-offline-browser.test.ts`, which reads the JSON it prints.
 * `DOC_OFFLINE_SHOTS=<dir>` also writes screenshots at 1180x820 and 430x932.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import type { DocOfflineRun } from './doc-offline-browser-reading.ts';

const DOC = '# Saltmarsh field notes\n\nThe tide table for Harborlight.\n';
const TYPED = ' Riverbend ferry added offline.';
const TEXT = `document.querySelector('#editor .ProseMirror')?.textContent ?? ''`;

const step = (what: string): void => {
  process.stderr.write(`[doc-offline-driver] ${what}\n`);
};

async function until<T>(
  what: string,
  read: () => Promise<T | null> | T | null,
  ms = 40_000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(100);
  }
  throw new Error(`never happened: ${what}`);
}

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'doc-offline-'));
  const shots = process.env.DOC_OFFLINE_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  let handle: ServerHandle | undefined;
  try {
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    step('build the doc bundle');
    const appPkg = join(import.meta.dirname, '..');
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
    if (built.status !== 0) throw new Error(`doc bundle build failed:\n${built.stderr}`);
    const serve = (port: number) =>
      createServer({
        port,
        dataDir: join(dir, 'data'),
        widgetDistDir: widgetDist,
        markdownAppDistDir: appDist,
        requireSignInToWrite: false,
      });
    handle = serve(0);
    const port = handle.port;
    const base = `http://127.0.0.1:${port}`;
    const post = async (path: string, payload: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const file = join(dir, 'field-notes.md');
    writeFileSync(file, DOC);
    const author = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author })) as { workspace: { id: string } }
    ).workspace.id;
    const docId = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'field-notes',
          type: 'markdown',
          sourceUrl: file,
        })
      ).docId,
    );
    await post(`/workspaces/${ws}/docs/${docId}/threads/by_find`, {
      author,
      text: 'Is this the spring table?',
      find: 'tide table',
    });
    const url = `${base}/workspaces/${ws}/docs/${docId}`;

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `doc-offline-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // A returning reader: a first arrival gets the name prompt over the doc.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
    });
    const text = async () => String(await cdp.evaluate(TEXT));
    const shot = async (name: string) => {
      if (!shots) return;
      for (const [w, h] of [
        [1180, 820],
        [430, 932],
      ] as const) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: w,
          height: h,
          deviceScaleFactor: 1,
          mobile: w <= 1100,
        });
        const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
          data: string;
        };
        writeFileSync(join(shots, `${name}-${w}.png`), Buffer.from(png.data, 'base64'));
      }
      await cdp.send('Emulation.clearDeviceMetricsOverride');
    };
    const load = async (go: () => Promise<unknown>) => {
      const loaded = cdp.once('Page.loadEventFired');
      await go();
      await loaded;
    };

    step('open the doc online');
    await load(() => cdp.send('Page.navigate', { url }));
    const online = await until('the doc online', async () => {
      const t = await text();
      return t.includes('tide table') ? t : null;
    });
    // The worker takes the page over and keeps what it loaded; the copy is
    // written once the server's sync has landed.
    const controlled = await until('the worker in control', async () =>
      (await cdp.evaluate('!!navigator.serviceWorker.controller')) ? true : null,
    );
    await until('the copy kept', async () =>
      (await cdp.evaluate(`new Promise((r) => {
        const o = indexedDB.open('cw-doc-cache');
        o.onsuccess = () => {
          const d = o.result;
          if (!d.objectStoreNames.contains('docs')) return r(false);
          const g = d.transaction('docs').objectStore('docs').get(${JSON.stringify(docId)});
          g.onsuccess = () => r(!!g.result);
          g.onerror = () => r(false);
        };
        o.onerror = () => r(false);
      })`))
        ? true
        : null,
    );
    // The worker keeps the page's files in the background after it is told.
    await until('the doc bundle kept', async () =>
      Number(
        await cdp.evaluate(
          `caches.open('cw-assets-v1').then((c) => c.keys()).then((k) => k.filter((r) => /\\/app\\/app-[0-9a-f]+\\.js$/.test(r.url)).length)`,
        ),
      ) > 0
        ? true
        : null,
    );

    step('cut the network: stop the server, reload');
    await handle.stop();
    handle = undefined;
    await load(() => cdp.send('Page.reload', {}));
    const offline = await until('the doc offline', async () => {
      const t = await text();
      return t.includes('tide table') ? t : null;
    });
    const labelOffline = String(
      await cdp.evaluate(`document.getElementById('doc-title')?.textContent ?? ''`),
    );
    const commentsOffline = Number(
      await until('the comment offline', async () => {
        const n = Number(
          await cdp.evaluate(`document.querySelectorAll('#editor .thread-range').length`),
        );
        return n > 0 ? n : null;
      }),
    );
    // Past the reconnect grace (connection-state.ts), the chip says so.
    const chipOffline = await until('the chip to settle', async () => {
      const t = String(
        await cdp.evaluate(`document.getElementById('save-state')?.textContent ?? ''`),
      );
      return t.includes('Reconnecting') ? t : null;
    });
    await shot('offline');

    step('type offline, then reload, still offline');
    await cdp.evaluate(`(() => {
      const ed = document.querySelector('#editor .ProseMirror');
      ed.focus();
      const p = [...ed.querySelectorAll('p')].find((x) => x.textContent.includes('tide table'));
      const r = document.createRange();
      r.selectNodeContents(p);
      r.collapse(false);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
    })()`);
    await cdp.send('Input.insertText', { text: TYPED });
    await until('the typed words on screen', async () =>
      (await text()).includes(TYPED.trim()) ? true : null,
    );
    const fileWhileOffline = readFileSync(file, 'utf8');
    await load(() => cdp.send('Page.reload', {}));
    const offlineAfterEdit = await until('the doc offline after the edit', async () => {
      const t = await text();
      return t.includes('tide table') ? t : null;
    });

    step('bring the server back on the same port');
    handle = serve(port);
    const fileAfterReconnect = await until('the typed words in the file', () => {
      const f = readFileSync(file, 'utf8');
      return f.includes(TYPED.trim()) ? f : null;
    });
    cdp.close();

    const run: DocOfflineRun = {
      online,
      controlled,
      offline,
      labelOffline,
      commentsOffline,
      chipOffline,
      fileWhileOffline,
      offlineAfterEdit,
      fileAfterReconnect,
    };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
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
