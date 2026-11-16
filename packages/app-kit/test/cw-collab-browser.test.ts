/**
 * `cw-collab.js` in a real browser, the way a Worker app with no bundler uses
 * it: a page served from the app's own origin loads it with a plain
 * `<script src>` tag, binds a textarea through `window.cwCollab`, and a second
 * tab sees what the first typed, through the kit's Durable Object in workerd.
 *
 * audit: no-text — the page is driven and read in Chromium; nothing here
 * asserts on a source file or a bundle's text.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import {
  type Browser,
  Cdp,
  launchChrome,
  pageSocketUrl,
  stopBrowser,
} from '../../../scripts/headless-chrome.ts';
import { STARTUP_TIMEOUT_MS, chromeLaunchArgs } from '../../../scripts/ui-shot-lib.ts';
import { buildClient } from '../scripts/build-client.ts';
import { until } from './poll.ts';
import { type LocalWorker, startWorker } from './workerd-harness.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

/** A page as an app would write it: one script tag, no bundler. */
const PAGE = (wsBase: string) => `<!doctype html>
<meta charset="utf-8">
<textarea id="body"></textarea>
<p id="status"></p>
<script src="/cw-collab.js"></script>
<script>
  const params = new URLSearchParams(location.search);
  const sync = cwCollab.connectDoc(
    ${JSON.stringify(wsBase)} + '/docs/harborlight-tag/ws?role=edit&user=' + params.get('user'),
  );
  sync.synced.then(() => {
    cwCollab.bindTextarea(document.getElementById('body'), sync.doc.getText('body'));
    document.getElementById('status').textContent = 'synced';
  });
</script>`;

let worker: LocalWorker;
let site: Server;
let origin: string;
let browser: Browser | undefined;
let outDir: string;
const tabs: Cdp[] = [];

describe.skipIf(CHROME === null)('cw-collab.js from a plain script tag', () => {
  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'cw-collab-browser-'));
    const built = buildClient(outDir);
    worker = await startWorker('doc-worker.ts', { DOC: 'DocRoom' });
    site = createServer((req, res) => {
      if (req.url === '/cw-collab.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(readFileSync(built.iife));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE(worker.ws));
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const addr = site.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${addr.port}`;
    browser = await launchChrome(
      CHROME as string,
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      'cw-collab',
    );
  }, 90_000);

  afterAll(async () => {
    if (browser) {
      // Let Chrome finish writing its profile and exit before it is removed.
      const proc = browser.proc;
      const exited = new Promise<void>((r) =>
        proc.exitCode !== null ? r() : proc.once('exit', () => r()),
      );
      await tabs[0]?.send('Browser.close').catch(() => {});
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      await stopBrowser(proc, browser.profile);
    }
    for (const t of tabs) t.close();
    await new Promise<void>((r) => (site ? site.close(() => r()) : r()));
    await worker?.dispose();
    rmSync(outDir, { recursive: true, force: true });
  });

  async function open(user: string, first: boolean): Promise<Cdp> {
    const port = (browser as Browser).port;
    const url = `${origin}/?user=${user}`;
    let ws: string;
    if (first) ws = await pageSocketUrl(port, STARTUP_TIMEOUT_MS);
    else {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
      ws = ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
    }
    const cdp = await Cdp.connect(ws);
    tabs.push(cdp);
    await cdp.send('Page.enable');
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url });
    await loaded;
    await until(
      `${user}'s tab to sync`,
      async () =>
        (await cdp.evaluate(`document.getElementById('status').textContent`)) === 'synced',
      15_000,
    );
    return cdp;
  }

  it('defines window.cwCollab, and what one tab types reaches the other', async () => {
    const one = await open('alice', true);
    const two = await open('bob', false);
    expect(await one.evaluate('typeof window.cwCollab.connectDoc')).toBe('function');
    await one.evaluate(`(() => {
      const box = document.getElementById('body');
      box.focus();
      box.value = 'typed in tab one';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await until(
      'the second tab to show it',
      async () =>
        (await two.evaluate(`document.getElementById('body').value`)) === 'typed in tab one',
      15_000,
    );
  }, 60_000);
});
