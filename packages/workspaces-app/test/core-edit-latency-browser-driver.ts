#!/usr/bin/env bun
/**
 * The M8 cutover trial in a real browser, on a board on the collab core:
 *
 *   - bar 3: a page outside the board, served by a dev server of its own on
 *     another port and built from the app kit's page client alone
 *     (`core-outside-page-entry.ts`), joins the doc's room on the core, holds
 *     the doc, and its edit reaches the server;
 *   - bar 2: an edit made by a raw page reaches the board's own doc page in
 *     headless Chromium — its socket (stored state) and its editor (screen) —
 *     on the named doc (`server/test/core-edit-latency.ts`), five times.
 *
 * Throwaway everything: a port-0 server over a temp data folder with
 * `collabCoreDefault`, so the board is on the core without a switch call.
 *
 * Clocks: the edit is stamped in this process and the page's two moments in
 * the page, both as epoch milliseconds at sub-millisecond grain
 * (`performance.timeOrigin + performance.now()`); one machine, one clock.
 * The stored stamp is taken in a task queued from the socket's message event,
 * so it lands after the page's own handler applied the frame: an upper bound.
 *
 * Spawned by `core-edit-latency-browser.test.ts`, which reads the JSON it prints.
 */
import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  type Page,
  appendParagraph,
  openPage,
  proseText,
} from '../../server/test/collab-core-page.ts';
import {
  TIDE_TABLE,
  TIDE_TABLE_BYTES,
  TIDE_TABLE_WEEKS,
  epochNow,
} from '../../server/test/core-edit-latency.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';
import type { CoreEditLatencyRun, EditSeen } from './core-edit-latency-reading.ts';

const LAST_SECTION = `Week ${TIDE_TABLE_WEEKS}`;
const RUNS = 5;

const step = (what: string): void => {
  process.stderr.write(`[core-edit-latency-driver] ${what}\n`);
};

/** Installed before the doc page's own scripts: stamps, for each words the
 *  driver names in `__cwPending`, when a socket frame carrying them had been
 *  applied and when the editor first showed them. */
const PROBE = `(() => {
  try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}
  const now = () => performance.timeOrigin + performance.now();
  window.__cwPending = [];
  window.__cwSeen = {};
  const seen = (w) => (window.__cwSeen[w] ??= {});
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', (ev) => {
        if (!(ev.data instanceof ArrayBuffer) || window.__cwPending.length === 0) return;
        const text = decoder.decode(ev.data);
        for (const w of window.__cwPending) {
          if (text.includes(w) && seen(w).stored === undefined) {
            seen(w).arrived = now();
            setTimeout(() => { seen(w).stored = now(); }, 0);
          }
        }
      });
    }
  };
  const check = () => {
    const ed = document.getElementById('editor');
    if (!ed) return;
    if (!window.__cwReady && ed.textContent.includes(${JSON.stringify(LAST_SECTION)})) {
      window.__cwReady = true;
    }
    if (window.__cwPending.length === 0) return;
    const text = ed.textContent;
    for (const w of window.__cwPending) {
      if (seen(w).screen === undefined && text.includes(w)) seen(w).screen = now();
    }
  };
  new MutationObserver(check).observe(document, {
    subtree: true, childList: true, characterData: true,
  });
})();`;

let browser: { proc: ChildProcess; profile: string } | undefined;

async function until<T>(what: string, read: () => Promise<T | null>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(25);
  }
  throw new Error(`never happened: ${what}`);
}

async function post(
  base: string,
  path: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}

async function buildOutsidePage(outDir: string): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dirname, 'core-outside-page-entry.ts')],
    outdir: outDir,
    target: 'browser',
    naming: 'outside.js',
  });
  if (!built.success) throw new Error(`outside page build failed: ${built.logs.join('\n')}`);
  return join(outDir, 'outside.js');
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'core-edit-latency-'));
  let handle: ServerHandle | undefined;
  let dev: ReturnType<typeof Bun.serve> | undefined;
  const pages: Page[] = [];
  try {
    step('build the widget, the doc bundle and the outside page');
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`doc bundle build failed:\n${built.stderr}`);
    const outsideJs = await buildOutsidePage(join(dir, 'outside'));

    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
      collabCoreDefault: true,
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const author = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };
    const ws = (
      (await post(base, '/workspaces', { name: 'Harborlight', author })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const file = join(dir, 'tide-table.md');
    writeFileSync(file, TIDE_TABLE);
    const docId = String(
      (
        await post(base, `/workspaces/${ws}/docs`, {
          docId: 'tide-table',
          type: 'markdown',
          sourceUrl: file,
        })
      ).docId,
    );
    const socketUrl = `${base.replace('http', 'ws')}/workspaces/${ws}/docs/${docId}/y`;

    // The page outside the board: its own server, its own origin.
    const html =
      '<!doctype html><meta charset="utf-8"><title>Saltmarsh outside page</title>' +
      '<script type="module" src="/outside.js"></script>';
    dev = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) =>
        new URL(req.url).pathname === '/outside.js'
          ? new Response(Bun.file(outsideJs), { headers: { 'content-type': 'text/javascript' } })
          : new Response(html, { headers: { 'content-type': 'text/html' } }),
    });
    const devOrigin = `http://127.0.0.1:${dev.port}`;

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `core-edit-latency-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    step('bar 3: the outside page joins the room');
    await cdp.send('Page.navigate', {
      url: `${devOrigin}/?socket=${encodeURIComponent(socketUrl)}`,
    });
    const status = await until('the outside page synced', async () => {
      const s = (await cdp.evaluate('window.__outside?.status() ?? null')) as string | null;
      return s === 'synced' ? s : null;
    });
    const heldDoc = Boolean(
      await until(
        'the outside page held the doc',
        async () =>
          (await cdp.evaluate(
            `window.__outside.text().includes(${JSON.stringify(LAST_SECTION)}) || null`,
          )) as boolean | null,
      ),
    );
    const coreRoomsWhileAlone = handle.collabCore.path.openRooms();
    const raw = openPage(socketUrl, base);
    pages.push(raw);
    await raw.ready;
    const outsideWords = 'Saltmarsh outside page note';
    await cdp.evaluate(`window.__outside.append(${JSON.stringify(outsideWords)})`);
    const editReachedServer = Boolean(
      await until('the outside page edit on a raw page', async () =>
        proseText(raw.ydoc).includes(outsideWords) ? true : null,
      ),
    );

    step('bar 2: the board doc page, stored state and screen');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    await cdp.send('Page.navigate', { url: `${base}/workspaces/${ws}/docs/${docId}` });
    await until(
      'the doc page showing the whole doc',
      async () => (await cdp.evaluate('window.__cwReady ?? null')) as boolean | null,
    );
    const coreRoomsWithDocPage = handle.collabCore.path.openRooms();
    const edits: EditSeen[] = [];
    for (let i = 1; i <= RUNS; i++) {
      const words = `Riverbend ferry run ${i} leaves on the hour.`;
      await cdp.evaluate(`window.__cwPending.push(${JSON.stringify(words)})`);
      const editedAt = epochNow();
      appendParagraph(raw.ydoc, words);
      const seen = await until(`run ${i} seen on the doc page`, async () => {
        const v = (await cdp.evaluate(`window.__cwSeen[${JSON.stringify(words)}] ?? null`)) as {
          stored?: number;
          screen?: number;
        } | null;
        return v && v.stored !== undefined && v.screen !== undefined
          ? { stored: v.stored, screen: v.screen }
          : null;
      });
      edits.push({ storedMs: seen.stored - editedAt, screenMs: seen.screen - editedAt });
    }
    cdp.close();

    const run: CoreEditLatencyRun = {
      docBytes: TIDE_TABLE_BYTES,
      docWeeks: TIDE_TABLE_WEEKS,
      outside: {
        origin: devOrigin,
        boardOrigin: base,
        status,
        heldDoc,
        coreRoomsWhileAlone,
        docId,
        editReachedServer,
      },
      edits,
      coreRoomsWithDocPage,
    };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    for (const p of pages) p.close();
    if (browser) await stopBrowser(browser.proc, browser.profile);
    dev?.stop(true);
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
