#!/usr/bin/env bun
/**
 * A slow device reloads an offline doc right after typing, in headless
 * Chromium against a real server and the real doc bundle.
 *
 * The page keeps a copy of the doc in IndexedDB (doc-cache.ts). The reader
 * opens a doc online, the network is cut (the server stopped AND the page's
 * network emulated offline, proved by a fetch that answered online and fails
 * now), the CPU is slowed 25 times, they type and reload at once: well inside
 * the 800ms the copy's full save waits. The words have to be on the offline
 * page after the reload, and once the page reloads online they have to reach
 * the doc's file exactly once. Repeated `SAVE_RACE_TRIES` times (default 5),
 * because it is a race.
 *
 * Then, at the same slowed CPU, it times single typed characters, and checks
 * that a session answering as somebody else clears what the old identity
 * left in the copy, the appended edits included.
 *
 * Spawned by `doc-save-race-browser.test.ts`, which reads the JSON it prints.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import type { SaveRaceRun, SaveRaceTry } from './doc-save-race-browser-reading.ts';

const DOC = '# Saltmarsh field notes\n\nThe tide table for Harborlight.\n';
const TEXT = `document.querySelector('#editor .ProseMirror')?.textContent ?? ''`;
const PROBE = `fetch('/api/auth/session', { cache: 'no-store' }).then(() => 'reached', () => 'failed')`;
const SLOW_CPU = 25;
const TRIES = Math.max(1, Number(process.env.SAVE_RACE_TRIES ?? 5) || 5);
const WORDS = ['slipway', 'jetty', 'mooring', 'breakwater', 'boathouse', 'lighthouse', 'buoy'];
const KEYSTROKES = 20;

const step = (what: string): void => {
  process.stderr.write(`[doc-save-race-driver] ${what}\n`);
};

async function until<T>(
  what: string,
  read: () => Promise<T | null> | T | null,
  ms = 60_000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(100);
  }
  throw new Error(`never happened: ${what}`);
}

const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'doc-save-race-'));
  let handle: ServerHandle | undefined;
  try {
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    step('build the doc bundle');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
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
    const url = `${base}/workspaces/${ws}/docs/${docId}`;

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `doc-save-race-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
    });
    cdp.on('Page.javascriptDialogOpening', () => {
      void cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });
    const text = async () => String(await cdp.evaluate(TEXT));
    const load = async (go: () => Promise<unknown>) => {
      const loaded = cdp.once('Page.loadEventFired');
      await go();
      await Promise.race([loaded, sleep(60_000)]);
    };
    const showsDoc = () =>
      until('the doc', async () => ((await text()).includes('tide table') ? true : null));
    const net = (offline: boolean) =>
      cdp.send('Network.emulateNetworkConditions', {
        offline,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
    const cpu = (rate: number) => cdp.send('Emulation.setCPUThrottlingRate', { rate });
    /** When the doc's copy was last written in full, or 0 for none. */
    const copySavedAt = async (): Promise<number> =>
      Number(
        await cdp.evaluate(`new Promise((r) => {
          const o = indexedDB.open('cw-doc-cache');
          o.onsuccess = () => {
            const d = o.result;
            if (!d.objectStoreNames.contains('docs')) return r(0);
            const g = d.transaction('docs').objectStore('docs').get(${JSON.stringify(docId)});
            g.onsuccess = () => r(g.result?.savedAt ?? 0);
            g.onerror = () => r(0);
          };
          o.onerror = () => r(0);
        })`),
      );
    /** Appended edits kept for the doc, or null when the browser has no such
     *  store. Asks for the database list first: opening one that does not
     *  exist would create it empty. */
    const appendedRows = async (): Promise<number | null> =>
      (await cdp.evaluate(`indexedDB.databases().then((all) => {
        if (!all.some((d) => d.name === 'cw-doc-cache-updates')) return null;
        return new Promise((r) => {
          const o = indexedDB.open('cw-doc-cache-updates');
          o.onsuccess = () => {
            const d = o.result;
            if (!d.objectStoreNames.contains('updates')) return r(null);
            const id = ${JSON.stringify(docId)};
            const g = d.transaction('updates').objectStore('updates')
              .count(IDBKeyRange.bound([id], [id, []]));
            g.onsuccess = () => r(g.result);
            g.onerror = () => r(null);
          };
          o.onerror = () => r(null);
        });
      })`)) as number | null;
    const caretAtEnd = () =>
      cdp.evaluate(`(() => {
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
    const probesOffline: string[] = [];
    const goOffline = async () => {
      await handle?.stop();
      handle = undefined;
      await net(true);
      const probe = String(await cdp.evaluate(PROBE));
      probesOffline.push(probe);
      if (probe !== 'failed') throw new Error(`the cut did not hold: the page ${probe} the server`);
    };
    const goOnline = async () => {
      await net(false);
      handle = serve(port);
      await until('the server reachable', async () =>
        (await fetch(`${base}/api/auth/session`).then(
          (r) => r.ok,
          () => false,
        ))
          ? true
          : null,
      );
    };
    /** Type at the slowed CPU and reload at once, still offline. */
    const typeAndReload = async (words: string) => {
      await caretAtEnd();
      await cpu(SLOW_CPU);
      const t0 = Date.now();
      await cdp.send('Input.insertText', { text: words });
      const onScreenBeforeReload = (await text()).includes(words.trim());
      const typedToReloadMs = Date.now() - t0;
      await load(() => cdp.send('Page.reload', {}));
      await showsDoc();
      const shownAfterReload = (await text()).includes(words.trim());
      await cpu(1);
      return { onScreenBeforeReload, typedToReloadMs, shownAfterReload };
    };

    step('open the doc online');
    await load(() => cdp.send('Page.navigate', { url }));
    await showsDoc();
    const probeOnline = String(await cdp.evaluate(PROBE));
    await until('the worker in control', async () =>
      (await cdp.evaluate('!!navigator.serviceWorker.controller')) ? true : null,
    );
    await until('the copy kept', async () => ((await copySavedAt()) > 0 ? true : null));
    await until('the doc bundle kept', async () =>
      Number(
        await cdp.evaluate(
          `caches.open('cw-assets-v1').then((c) => c.keys()).then((k) => k.filter((r) => /\\/app\\/app-[0-9a-f]+\\.js$/.test(r.url)).length)`,
        ),
      ) > 0
        ? true
        : null,
    );

    const tries: SaveRaceTry[] = [];
    for (let i = 0; i < TRIES; i++) {
      const words = ` Riverbend ${WORDS[i % WORDS.length]} ${i + 1} typed offline.`;
      step(`try ${i + 1}: cut, type at ${SLOW_CPU}x CPU, reload at once`);
      await goOffline();
      const r = await typeAndReload(words);
      const inFileWhileOffline = count(readFileSync(file, 'utf8'), words.trim());
      step(`try ${i + 1}: back online, reload`);
      await goOnline();
      await load(() => cdp.send('Page.reload', {}));
      await showsDoc();
      const landed = await until(
        'the words in the file',
        () => {
          const n = count(readFileSync(file, 'utf8'), words.trim());
          return n > 0 ? n : null;
        },
        10_000,
      ).catch(() => 0);
      // A second copy would land on a later write-back: give it one.
      await sleep(landed > 0 ? 2_500 : 0);
      tries.push({
        words: words.trim(),
        ...r,
        inFileWhileOffline,
        inFileAfterOnline: count(readFileSync(file, 'utf8'), words.trim()),
      });
      step(`try ${i + 1}: ${JSON.stringify(tries[tries.length - 1])}`);
    }

    step(`time ${KEYSTROKES} typed characters at ${SLOW_CPU}x CPU`);
    await goOffline();
    await caretAtEnd();
    await cpu(SLOW_CPU);
    const keystrokeMs: number[] = [];
    await cdp.send('Performance.enable');
    const busy = async () => {
      const { metrics } = (await cdp.send('Performance.getMetrics')) as {
        metrics: Array<{ name: string; value: number }>;
      };
      const of = (n: string) => metrics.find((m) => m.name === n)?.value ?? 0;
      return { task: of('TaskDuration'), script: of('ScriptDuration') };
    };
    const busyBefore = await busy();
    for (let i = 0; i < KEYSTROKES; i++) {
      const t0 = performance.now();
      await cdp.send('Input.insertText', { text: 'abcdefghijklmnopqrst'[i] ?? 'x' });
      keystrokeMs.push(Math.round((performance.now() - t0) * 10) / 10);
    }
    // Past the full write's debounce, so its cost is counted as well.
    await sleep(2_000);
    const busyAfter = await busy();
    const perKey = (s: number) => Math.round((s * 10_000) / KEYSTROKES) / 10;
    const mainThreadMsPerKeystroke = {
      task: perKey(busyAfter.task - busyBefore.task),
      script: perKey(busyAfter.script - busyBefore.script),
    };
    await cpu(1);

    step('a session answering as somebody else clears the copy');
    await typeAndReload(' Saltmarsh slipway typed under the old identity.');
    // Whether the closing page's full write landed and dropped its own edits
    // is the race above, so the control does not rest on it: an edit another
    // tab appended, which no full write on this page knows to drop.
    await cdp.evaluate(`indexedDB.databases().then((all) => {
      if (!all.some((d) => d.name === 'cw-doc-cache-updates')) return;
      return new Promise((r) => {
        const o = indexedDB.open('cw-doc-cache-updates');
        o.onsuccess = () => {
          const id = ${JSON.stringify(docId)};
          const tx = o.result.transaction('updates', 'readwrite');
          tx.objectStore('updates').put({ who: 'anon', update: new Uint8Array([0, 0]) }, [id, 'other-tab', 0]);
          tx.oncomplete = () => r();
          tx.onerror = () => r();
        };
        o.onerror = () => r();
      });
    })`);
    const appendedBeforeIdentityChange = await appendedRows();
    const savedBefore = await copySavedAt();
    await cdp.evaluate(`localStorage.setItem('cw.docCache.who', 'user:riverbend')`);
    await goOnline();
    await load(() => cdp.send('Page.reload', {}));
    await showsDoc();
    const appendedAfterIdentityChange = await appendedRows();
    const savedAfter = await copySavedAt();
    cdp.close();

    const run: SaveRaceRun = {
      probeOnline,
      probesOffline,
      cpuSlowdown: SLOW_CPU,
      tries,
      keystrokeMs,
      mainThreadMsPerKeystroke,
      appendedBeforeIdentityChange,
      appendedAfterIdentityChange,
      oldCopyAfterIdentityChange: savedBefore > 0 && savedAfter === savedBefore,
    };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 290s');
  const b = browser;
  void (b ? stopBrowser(b.proc, b.profile) : Promise.resolve()).finally(() => process.exit(3));
}, 290_000).unref();
await main();
process.exit(0);
